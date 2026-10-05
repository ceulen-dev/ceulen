// ponytail: ported from oh-my-pi tools/read-selector.ts + pi-tui
// tools/line-ranges.ts (lean). Path-embedded line selectors for the wrapped
// read tool: `:50`, `:50-200`, `:50+150`, `:50-`, `:-60`, `:5-16,960-973`,
// `:19,59`, `:raw` compounds, `:conflicts`. `:img` is dropped (pi read does
// not render SVGs). Resolution contract (OMP issue #4618): a LITERAL path
// that exists on disk always wins — peel the selector only when the raw path
// does not exist and the remainder parses.

// ── Line ranges (OMP line-ranges.ts) ──

/** Inclusive line range; `endLine` undefined = open-ended (to EOF). */
export interface LineRange {
  startLine: number;
  endLine: number | undefined;
}

const LINE_RANGE_CHUNK_RE = /^L?(\d+)(?:(\.\.|[-+])L?(\d+)?)?$/i;

/** Parse one `N`, `N-M`, `N-`, `N+K`, or `..`-aliased chunk; null when not range-shaped. */
export function parseLineRangeChunk(sel: string): LineRange | null {
  return parseChunk(sel, false);
}

/** `pinBare` makes a separator-less `N` the single line N instead of "from N onward". */
function parseChunk(sel: string, pinBare: boolean): LineRange | null {
  const m = LINE_RANGE_CHUNK_RE.exec(sel);
  if (!m) return null;
  const rawStart = Number.parseInt(m[1], 10);
  if (rawStart < 1) throw new SelectorError("Line selector 0 is invalid; lines are 1-indexed. Use :1.");
  // `..` is a forgiving alias for `-` (2724..2727 == 2724-2727).
  const sep = m[2] === ".." ? "-" : m[2];
  const rhs = m[3] ? Number.parseInt(m[3], 10) : undefined;
  let rawEnd: number | undefined;
  if (sep === "+") {
    if (rhs === undefined || rhs < 1) throw new SelectorError(`Invalid range ${rawStart}+${rhs ?? 0}: count must be >= 1.`);
    rawEnd = rawStart + rhs - 1;
  } else if (sep === "-") {
    if (rhs !== undefined) {
      if (rhs < rawStart) throw new SelectorError(`Invalid range ${rawStart}-${rhs}: end must be >= start.`);
      rawEnd = rhs;
    }
  } else if (pinBare) {
    rawEnd = rawStart;
  }
  return { startLine: rawStart, endLine: rawEnd };
}

/** Comma-separated ranges, ascending, overlapping/adjacent merged (OMP). */
export function parseLineRanges(sel: string): [LineRange, ...LineRange[]] | null {
  const chunks = sel.split(",");
  // A lone `:50` means "from line 50"; inside a comma list a bare number is
  // that one line (`:19,59` = lines 19 and 59).
  const pinBare = chunks.length > 1;
  const parsed: LineRange[] = [];
  for (const chunk of chunks) {
    const range = parseChunk(chunk, pinBare);
    if (!range) return null;
    parsed.push(range);
  }
  if (parsed.length === 0) return null;
  parsed.sort((a, b) => a.startLine - b.startLine);
  const merged: LineRange[] = [parsed[0]];
  for (let i = 1; i < parsed.length; i++) {
    const current = parsed[i];
    const last = merged[merged.length - 1];
    if (last.endLine === undefined) continue; // open-ended absorbs everything later
    if (current.startLine <= last.endLine + 1) {
      if (current.endLine === undefined || current.endLine > last.endLine) {
        merged[merged.length - 1] = { startLine: last.startLine, endLine: current.endLine };
      }
      continue;
    }
    merged.push(current);
  }
  return merged as [LineRange, ...LineRange[]];
}

// ── Selector grammar (OMP read-selector.ts) ──

export class SelectorError extends Error {}

export type ParsedSelector =
  | { kind: "none" }
  | { kind: "raw" }
  | { kind: "conflicts" }
  | { kind: "lines"; ranges: [LineRange, ...LineRange[]]; raw?: boolean }
  /** `:-N` — the last N lines; needs the line count before slicing. */
  | { kind: "tail"; count: number; raw?: boolean };

export function isRawSelector(parsed: ParsedSelector): boolean {
  return parsed.kind === "raw" || ((parsed.kind === "lines" || parsed.kind === "tail") && parsed.raw === true);
}

export function isMultiRange(parsed: ParsedSelector): boolean {
  return parsed.kind === "lines" && parsed.ranges.length > 1;
}

/** Pin a `:-N` tail selector to absolute lines against `totalLines`. */
export function resolveTailSelector(parsed: ParsedSelector, totalLines: number): Exclude<ParsedSelector, { kind: "tail" }> {
  if (parsed.kind !== "tail") return parsed;
  const startLine = Math.max(1, totalLines - parsed.count + 1);
  // `raw: undefined` is omitted so strict deep-equal tests see the plain shape.
  const resolved: Exclude<ParsedSelector, { kind: "tail" }> = {
    kind: "lines",
    ranges: [{ startLine, endLine: Math.max(startLine, totalLines) }],
  };
  if (parsed.raw === true) resolved.raw = true;
  return resolved;
}

/** True when a compound chunk looks selector-like (drives the invalid-compound throw). */
function selectorChunkLooksReadLike(chunk: string): boolean {
  const lower = chunk.toLowerCase();
  return lower === "raw" || lower === "conflicts" || /^-\d+(?:[-+]\d+)?$/.test(chunk) || parseLineRanges(chunk) !== null;
}

function invalidSelector(sel: string): SelectorError {
  return new SelectorError(
    `Invalid selector ':${sel}'. Use :N, :N-M, :N+K, :N- (open-ended), :-N (last N lines), a comma-separated list of ranges, :raw, :conflicts, or a range combined with raw (e.g. :raw:50-100).`,
  );
}

function parseRangeOrTail(chunk: string, raw: boolean): ParsedSelector | null {
  const ranges = parseLineRanges(chunk);
  if (ranges) return raw ? { kind: "lines", ranges, raw } : { kind: "lines", ranges };
  const count = parseTailCount(chunk);
  if (count !== null) return raw ? { kind: "tail", count, raw } : { kind: "tail", count };
  return null;
}

/** Parse a `-N` tail selector (`:-60` → 60 last lines); null when not tail-shaped. */
export function parseTailCount(sel: string): number | null {
  const match = /^-(\d+)$/.exec(sel);
  if (!match) return null;
  const count = Number.parseInt(match[1], 10);
  if (count < 1) throw new SelectorError("Tail selector -0 is invalid; use :-N with N >= 1 to read the last N lines.");
  return count;
}

export function parseSel(sel: string | undefined): ParsedSelector {
  if (!sel || sel.length === 0) return { kind: "none" };

  // Compound selector: `1-50:raw`, `raw:1-50`, `raw:-60` — exactly one range
  // (or tail) plus the literal `raw`. Selector-like compounds outside that
  // set are INVALID (never silently widened to "no selector").
  if (sel.includes(":")) {
    const chunks = sel.split(":");
    if (chunks.length === 2) {
      const [a, b] = chunks as [string, string];
      const aIsRaw = a.toLowerCase() === "raw";
      const bIsRaw = b.toLowerCase() === "raw";
      const rangeChunk = aIsRaw ? b : bIsRaw ? a : null;
      const rawChunk = aIsRaw ? a : bIsRaw ? b : null;
      if (rangeChunk !== null && rawChunk !== null) {
        const parsed = parseRangeOrTail(rangeChunk, true);
        if (parsed) return parsed;
      }
    }
    if (chunks.every(selectorChunkLooksReadLike)) throw invalidSelector(sel);
    // Unrecognized compound — treat as no selector (literal-path semantics).
    return { kind: "none" };
  }

  if (sel.toLowerCase() === "raw") return { kind: "raw" };
  if (sel.toLowerCase() === "conflicts") return { kind: "conflicts" };
  const parsed = parseRangeOrTail(sel, false);
  if (parsed) return parsed;
  // Unrecognized → no selector (the whole thing stays a literal path).
  return { kind: "none" };
}

/** Single range → offset/limit; multi-range callers MUST branch on isMultiRange first. */
export function selToOffsetLimit(parsed: Exclude<ParsedSelector, { kind: "tail" }>): { offset?: number; limit?: number } {
  if (parsed.kind === "lines") {
    const first = parsed.ranges[0];
    const limit = first.endLine !== undefined ? first.endLine - first.startLine + 1 : undefined;
    return { offset: first.startLine, limit };
  }
  return {};
}

// ── Path peeling ──

/**
 * Split `path:selector` → `{ stem, selector }` when the suffix parses as a
 * selector, else `{ stem: path }`. Caller contract (OMP #4618): probe literal
 * existence FIRST — only call this when the raw path does not exist.
 */
export function peelPathSelector(rawPath: string): { stem: string; selector?: ParsedSelector } {
  if (!rawPath.includes(":")) return { stem: rawPath };
  // Scheme-like prefixes (artifact://) never carry selectors here; a Windows
  // drive root (C:\, C:/) is part of the path, not a selector separator.
  if (rawPath.includes("://") || /^[A-Za-z]:[\\/]/.test(rawPath)) return { stem: rawPath };
  // Compound selectors (`f.ts:1-1:conflicts`) split at the FIRST colon whose
  // remainder parses as a selector; lastIndexOf would split at the last one and
  // misread `1-1:conflicts` as the stem.
  for (let idx = rawPath.indexOf(":"); idx > 0; idx = rawPath.indexOf(":", idx + 1)) {
    const stem = rawPath.slice(0, idx);
    const sel = rawPath.slice(idx + 1);
    if (!sel || stem.endsWith("/") || stem.endsWith(":")) continue;
    try {
      const parsed = parseSel(sel);
      if (parsed.kind !== "none") return { stem, selector: parsed };
    } catch (err) {
      // Selector-like but invalid → surface the parse error (OMP semantics).
      // The caller's literal-exists probe already ran: reaching here means the
      // raw path does NOT exist, so an invalid selector is a loud model error,
      // not a plausible literal filename.
      throw new SelectorError(
        `${rawPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return { stem: rawPath };
}

/** True when any line of the file content is inside the ranges. */
export function isLineInRanges(lineNumber: number, ranges: readonly LineRange[]): boolean {
  for (const range of ranges) {
    if (lineNumber < range.startLine) continue;
    if (range.endLine === undefined || lineNumber <= range.endLine) return true;
  }
  return false;
}

/** Extract merge-conflict blocks (<<<<<<< … >>>>>>>) from file lines. */
export function extractConflictBlocks(lines: readonly string[]): string[][] {
  const blocks: string[][] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (line.startsWith("<<<<<<<")) {
      current = [line];
    } else if (current !== null) {
      current.push(line);
      if (line.startsWith(">>>>>>>")) {
        blocks.push(current);
        current = null;
      }
    }
  }
  return blocks;
}
