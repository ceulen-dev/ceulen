// Spill policy — token-budgeted head/tail retention of oversized tool results.
//
// Ported from DeepSeek Harness `packages/spill/spill-policy` (retention.ts,
// notice.ts) + `packages/llm/token-meter/src/estimate.ts` (the fixed-density
// heuristic). Deliberate deviations, each load-bearing:
//
//  - NO image retention: pi tool results carry ImageContent only from `read`,
//    and image-bearing reads are excluded from spilling entirely (fail-open:
//    an image result is returned untouched). DSH prices images through a
//    per-route token calculator; pi exposes no such seam to extensions.
//  - ONE notice wording instead of DSH's `describeOmitted` library: that
//    library exists so DSH's browser can RECOGNIZE a persisted notice; ceulen
//    only ever writes one.
//  - Spill is scoped to RETURNED content. pi's read/bash truncate INSIDE the
//    tool before `tool_result` fires (read.js:117 truncateHead at
//    2000 lines/50KB; bash.js:261-270 sets fullOutputPath), so bytes they drop
//    are already gone. Those paths are excluded; the beneficiaries are the
//    tools with no self-truncation (extension tools: subagent reports, github,
//    web_extract, munin). The exclusion is `details.fullOutputPath` rather than
//    a tool list, which is what covers codemode: it self-truncates at 10,000
//    tokens (execute.js:248) and reports fullOutputPath, so at its default
//    budget it never reaches this seam (live herdr finding).

/** Fixed text-density estimate (DSH CHARS_PER_TOKEN). */
export const CHARS_PER_TOKEN = 4;
/** Per-block structural overhead for JSON framing and type tags (DSH BLOCK_OVERHEAD). */
export const BLOCK_OVERHEAD = 4;
/** DSH's base-preset budget (`packages/bundle/base/cordis.patch.yml` maxInlineTokens). */
export const DEFAULT_SPILL_MAX_TOKENS = 12_500;

/** Text whose head can be split from its tail; images are indivisible. */
export interface RetainableText {
  type: "text";
  text: string;
}

/** Retained ends plus the exact quantities excluded from the original. */
export interface RetainedContent {
  head: RetainableText[];
  tail: RetainableText[];
  omittedBytes: number;
}

/** Heuristic token price of one text (DSH estimateContent, text arm). */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD;
}

/** Heuristic token price of a block list's text arms. */
export function estimateTokens(blocks: readonly { type: string; text?: string }[]): number {
  let total = 0;
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string") total += estimateTextTokens(block.text);
  }
  return total;
}

/** Preserve a UTF-16 surrogate pair when a budget cut would split it. */
export function textSlice(text: string, length: number, tail: boolean): string {
  let cut = tail ? text.length - length : length;
  if (cut <= 0) return tail ? text : "";
  if (cut >= text.length) return tail ? "" : text;
  const previous = text.charCodeAt(cut - 1);
  const current = text.charCodeAt(cut);
  if (previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff) {
    cut += tail ? 1 : -1;
  }
  return tail ? text.slice(cut) : text.slice(0, cut);
}

/** Largest contiguous text end fitting a monotonic token estimate (DSH fitText). */
export function fitText(text: string, budget: number, tail: boolean): string {
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = textSlice(text, middle, tail);
    if (candidate.length === 0 || estimateTextTokens(candidate) <= budget) low = middle;
    else high = middle - 1;
  }
  return textSlice(text, low, tail);
}

/**
 * Retain contiguous ends of a text block without partial UTF-16 units.
 * Half the budget goes to the head and half to the tail (DSH retainContent);
 * a single oversized block is split between both ends.
 * @param texts ordered text blocks whose total price exceeds `budget`.
 * @param budget non-negative token budget, after reserving the notice.
 */
export function retainContent(texts: readonly string[], budget: number): RetainedContent {
  const head: RetainableText[] = [];
  const tail: RetainableText[] = [];
  let first = 0;
  let last = texts.length - 1;
  let headCharacters = 0;

  let remaining = Math.ceil(budget / 2);
  while (first <= last) {
    const text = texts[first]!;
    const cost = estimateTextTokens(text);
    if (cost <= remaining) {
      head.push({ type: "text", text });
      remaining -= cost;
      first++;
      continue;
    }
    const fitted = fitText(text, remaining, false);
    headCharacters = fitted.length;
    if (fitted.length > 0) head.push({ type: "text", text: fitted });
    break;
  }

  remaining = Math.floor(budget / 2);
  while (last >= first) {
    // When head and tail meet inside ONE block, the tail starts where the head
    // stopped (DSH's `last === first` arm) so no text is counted twice.
    const original = texts[last]!;
    const text = last === first ? original.slice(headCharacters) : original;
    const cost = estimateTextTokens(text);
    if (cost <= remaining) {
      if (text.length > 0) tail.push({ type: "text", text });
      remaining -= cost;
      last--;
      continue;
    }
    const fitted = fitText(text, remaining, true);
    if (fitted.length > 0) tail.push({ type: "text", text: fitted });
    break;
  }
  tail.reverse();

  const bytes = (blocks: readonly RetainableText[]): number =>
    blocks.reduce((total, block) => total + Buffer.byteLength(block.text, "utf8"), 0);
  const original = texts.reduce((total, text) => total + Buffer.byteLength(text, "utf8"), 0);
  return {
    head,
    tail,
    omittedBytes: original - bytes(head) - bytes(tail),
  };
}

/** Longest line pi's read returns in one go (DEFAULT_MAX_BYTES, read.js:117). */
export const PI_READ_LINE_LIMIT = 50 * 1024;

/**
 * Bytes pi's bash returns before truncating (truncate.js DEFAULT_MAX_BYTES).
 * Like the line cap, exceeding this makes bash drop the page's HEAD while our
 * offset advances past it. The token budget is NOT a substitute: a user who
 * raises `repair.spillMaxTokens` to 200,000 asks for a 100,000-byte page, which
 * is nearly twice this cap (measured) — so the byte window must be clamped
 * independently of the budget and of the line window.
 */
export const PI_BASH_BYTE_LIMIT = 50 * 1024;
/** Bytes a page may print, with headroom under pi's cap for the offset marker
 *  and a partial trailing line. */
export const PAGE_BYTE_LIMIT = 45_000;

/**
 * Lines pi's bash returns before truncating (truncate.js DEFAULT_MAX_LINES).
 * CRITICAL: bash truncates with `truncateTail` — it keeps the LAST 2000 lines
 * and DROPS THE HEAD (bash.js:270 "Showing lines X-Y"). A byte-capped page of
 * short lines therefore loses its head while our offset has already advanced
 * past those bytes, so they are gone for good. Measured: a 6,246-byte page of
 * 3-byte lines is 2,083 lines — 83 lines (249 bytes) silently dropped.
 */
export const PI_BASH_LINE_LIMIT = 2_000;
/** Lines a recovery page may print, well under pi's cap so the marker and any
 *  partial trailing line never push the result over it. */
export const PAGE_LINE_LIMIT = 1_900;

/**
 * Largest byte count a `cat | head -c N` recovery may print WITHOUT producing
 * another over-budget result (which would re-spill and loop the model).
 *
 * The hint must page UNDER the ACTIVE budget, not under pi's 50 KB read limit:
 * 50,000 ASCII chars estimates to 12,504 tokens with block overhead, which
 * exceeds the 12,500 default — so `head -c 50000` re-spills (measured). Half
 * the budget leaves room for the caller's own framing and for CJK/emoji text,
 * where 1 char is still 1 estimate unit but 3-4 bytes on disk.
 */
export function maxRecoveryBytes(maxTokens: number): number {
  const chars = Math.floor(maxTokens / 2) - BLOCK_OVERHEAD;
  return Math.max(0, chars);
}

/**
 * The byte window a page may print, shrunk so the page cannot exceed
 * `lineLimit` lines even in the worst case of the shortest possible line.
 *
 * A page is capped on BOTH axes because pi's bash caps both: exceeding
 * `PI_BASH_LINE_LIMIT` makes bash drop the page's HEAD (see that constant),
 * which silently loses bytes the offset has already skipped. With `minLine`
 * bytes per line (1 for a file of bare newlines) the safe byte window is
 * `minLine * lineLimit`; the caller estimates `minLine` from the payload.
 * The estimate is deliberately conservative — an under-sized page is a
 * harmless extra round trip, an over-sized one loses data.
 */
export function maxRecoveryPageBytes(maxTokens: number, minLine = 1): number {
  const byBudget = maxRecoveryBytes(maxTokens);
  const byLines = Math.max(1, minLine) * PAGE_LINE_LIMIT;
  // THREE independent caps: the token budget (no re-spill), the line cap (bash
  // drops the head past 2000 lines), and pi's 50 KiB byte cap (same head loss).
  // The budget alone does NOT imply the byte cap: a raised spillMaxTokens asks
  // for a page larger than pi will ever return.
  return Math.max(1, Math.min(byBudget, byLines, PAGE_BYTE_LIMIT));
}

/**
 * The notice appended to a retained preview.
 *
 * BOTH payload shapes page by bytes, because `read` is never a safe recovery
 * for a spilled result — the spill file exceeds the budget BY DEFINITION, so
 * any read that returns enough of it re-spills and loops the model:
 *
 *  - long-line payloads: pi's read REFUSES a single line over 50 KB
 *    ("Line 1 is 146.5KB, exceeds 50.0KB limit. Use bash: sed -n '1p' …"), so
 *    `read` is a dead end outright (measured in a herdr pane against ceulen's
 *    own spill file).
 *  - short-line payloads: read succeeds but caps at 50 KB / 2000 lines, which
 *    estimates to 12,504 tokens — OVER the 12,500 default — and at a lowered
 *    budget (say 2,000) even a 9 KB / 100-line read costs 2,254 tokens and
 *    spills again. `read` has no byte-budget parameter, so no line limit can be
 *    proven safe; byte offsets can.
 */
export function formatSpillNotice(
  omittedBytes: number,
  filePath: string,
  longestLine = 0,
  maxTokens = DEFAULT_SPILL_MAX_TOKENS,
  shortestLine = Number.POSITIVE_INFINITY,
): string {
  // Dual cap: the BYTE window keeps the page under the token budget, the LINE
  // window keeps it under pi's bash cap — exceeding the latter makes bash drop
  // the page's head while our offset advances past it (data loss).
  const chunk = maxRecoveryPageBytes(maxTokens, shortestLine);
  const why = longestLine > PI_READ_LINE_LIMIT
    ? "the long line is over read's 50KB limit"
    : "read would return more than this result's budget and spill again";
  // UTF-8 SAFETY: a raw `head -c N` splits multibyte characters at the page
  // boundary, and bash decodes each page INDEPENDENTLY — so the character is
  // lost in BOTH pages (measured: a 3-byte `日` straddling byte 996 decoded to
  // U+FFFD at page 1's end AND page 2's start). `iconv -c` drops the trailing
  // partial sequence, and the page reports the ACTUAL next offset (offset +
  // bytes printed) so paging never re-reads or skips a byte. Verified by full
  // round trip at chunk sizes 7 / 996 / 997 on multibyte fixtures: exact.
  // OFFSET is a shell VARIABLE set inside the -c body, not a literal to be
  // pasted: a naive template substitution breaks on the second page, because
  // the value appears twice (the tail -c argument and the next-offset
  // arithmetic). Start at 1 and feed each page's printed offset back in.
  const recovery = `Retrieve it in <=${PAGE_LINE_LIMIT}-line, ~${chunk}-byte UTF-8-safe pages with bash (${why}); `
    + `set OFFSET=1, then for each page feed the printed next OFFSET back in: `
    + `bash -c 'OFFSET=$1; f=$(mktemp); cat ${filePath} | tail -c +$OFFSET | head -c ${chunk} `
    + `| iconv -f UTF-8 -t UTF-8 -c 2>/dev/null | head -n ${PAGE_LINE_LIMIT} > "$f"; cat "$f"; `
    + `printf "[next OFFSET = %d]\\n" $((OFFSET + $(wc -c < "$f"))); rm -f "$f"' _ OFFSET`;
  return `\n\n[... ${omittedBytes} bytes omitted ...]\nFull output saved to: ${filePath}\n${recovery}`;
}

/** Longest line length in a text (0 for an empty string). */
export function longestLineLength(text: string): number {
  let longest = 0;
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text.charCodeAt(i) === 10) {
      if (i - start > longest) longest = i - start;
      start = i + 1;
    }
  }
  return longest;
}

/**
 * Shortest NON-EMPTY line length (1 when there are none) — the worst case for
 * the line cap, since short lines mean many lines per byte window.
 */
export function shortestLineLength(text: string): number {
  let shortest = Number.POSITIVE_INFINITY;
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text.charCodeAt(i) === 10) {
      const length = i - start;
      if (length > 0 && length < shortest) shortest = length;
      start = i + 1;
    }
  }
  return shortest === Number.POSITIVE_INFINITY ? 1 : shortest;
}
