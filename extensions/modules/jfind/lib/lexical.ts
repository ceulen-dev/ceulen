// ponytail: ported from oh-my-pi packages/coding-agent/src/tools/jfind
// {text,keywords,lexical}.ts — byte-budgeted text primitives + query keywords
// + the lexical prior. The native grep/glob engine (pi-natives) is swapped
// for a plain recursive walk + one streaming regex scan over file contents.

/** Split like Rust `str::lines`: `\n`-separated, trailing `\r` stripped, no phantom last line. */
export function lines(text: string): string[] {
  if (text.length === 0) return [];
  const out = text.split("\n");
  if (out[out.length - 1] === "") out.pop();
  for (let i = 0; i < out.length; i++) {
    const line = out[i]!;
    if (line.endsWith("\r")) out[i] = line.slice(0, -1);
  }
  return out;
}

/** Longest prefix of `text` that fits in `bytes` UTF-8 bytes without splitting a code point. */
export function clipBytes(text: string, bytes: number): string {
  if (Buffer.byteLength(text) <= bytes) return text;
  let used = 0;
  let end = 0;
  for (const char of text) {
    const width = Buffer.byteLength(char);
    if (used + width > bytes) break;
    used += width;
    end += char.length;
  }
  return text.slice(0, end);
}

/** First `count` code points of `text`. */
export function takeChars(text: string, count: number): string {
  let end = 0;
  let taken = 0;
  for (const char of text) {
    if (taken === count) break;
    end += char.length;
    taken++;
  }
  return text.slice(0, end);
}

/** Non-overlapping occurrences of `needle` in `haystack`; 0 for an empty needle. */
export function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count++;
    from = at + needle.length;
  }
}

// ── query keywords (jfind/keywords.ts) ──────────────────────────────────────

const STOPWORDS: Record<string, true> = Object.fromEntries(
  [
    "the", "a", "an", "or", "and", "to", "is", "are", "be", "when", "where", "how", "that", "this",
    "of", "in", "on", "at", "for", "with", "by", "its", "it", "as", "from", "into", "like", "gets",
    "get", "up", "which", "what", "does", "do", "code", "file", "files", "over", "all", "user",
    "using", "then", "than", "there", "their", "they", "them", "you", "your", "we", "our", "has",
    "have", "had", "was", "were", "been", "being", "will", "would", "should", "can", "could", "not",
    "but", "if", "so", "such", "via", "per", "any", "some", "each", "every", "also", "just", "only",
    "more", "most", "other", "out", "off", "about", "after", "before", "between", "through",
    "during", "without", "within", "one", "two", "new", "used", "use", "make", "makes", "made",
    "run", "runs", "way", "thing", "things", "something", "actually", "really", "still", "yet",
  ].map((word) => [word, true as const]),
);

/** Cheap stem so a substring match covers inflections: spawned→spawn, compacted→compact. */
function stem(token: string): string {
  for (const suffix of ["ing", "ed", "es", "s"]) {
    if (token.endsWith(suffix)) {
      const base = token.slice(0, -suffix.length);
      if (base.length >= 4) return base;
    }
  }
  return token;
}

/** Unicode letter, digit, or underscore — the token alphabet of the query. */
const TOKEN_RE = /[^\p{L}\p{N}_]+/u;
const DIGITS_RE = /^[0-9]+$/;

/** Keywords for the grep prior: quoted phrases whole, then tokens minus stopwords. */
export function keywordsFromQuery(query: string): string[] {
  const out: string[] = [];
  let rest = "";
  const chars = Array.from(query);
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (c !== '"' && c !== "'") {
      rest += c;
      continue;
    }
    let phrase = "";
    let closed = false;
    while (++i < chars.length) {
      if (chars[i] === c) {
        closed = true;
        break;
      }
      phrase += chars[i];
    }
    phrase = phrase.trim().toLowerCase();
    if (closed && Buffer.byteLength(phrase) >= 3) {
      out.push(phrase);
      rest += " ";
      continue;
    }
    rest += `${phrase} `;
  }
  for (const token of rest.split(TOKEN_RE)) {
    const lower = token.toLowerCase();
    if (Buffer.byteLength(lower) < 3 || Object.hasOwn(STOPWORDS, lower) || DIGITS_RE.test(lower)) continue;
    const stemmed = stem(lower);
    if (!out.includes(stemmed)) out.push(stemmed);
  }
  return out;
}

/** {@link keywordsFromQuery} plus the caller's extra keywords, lowercased and deduplicated. */
export function keywords(query: string, extra: readonly string[]): string[] {
  const out = keywordsFromQuery(query);
  for (const raw of extra) {
    const keyword = raw.trim().toLowerCase();
    if (keyword.length > 0 && !out.includes(keyword)) out.push(keyword);
  }
  return out;
}

// ── lexical prior (jfind/lexical.ts, natives swapped for a JS scan) ─────────

export interface GrepIndex {
  /** Lowercased, non-empty keywords; `perFileKw` vectors align with this. */
  keywords: string[];
  /** rel file path → per-keyword occurrence counts over matching lines. */
  perFileKw: Map<string, number[]>;
  /** Files the scan offered for reading, including oversized ones. */
  filesScanned: number;
}

/** Regex-escape a literal keyword for the scan alternation. */
function escapeRegex(keyword: string): string {
  return keyword.replace(/[\\.+*?()|[\]{}^$#&\-~]/g, "\\$&");
}

export interface GrepIndexOptions {
  signal?: AbortSignal;
  /** Files to scan (the walk's rel → abs map), already eligibility-filtered. */
  files: ReadonlyMap<string, string>;
  /** Bytes read per file for the scan. */
  scanLimitBytes?: number;
}

const SCAN_LIMIT_DEFAULT = 512 * 1024;
/** ponytail: hard read cap per file — a multi-GB log must not buffer whole.
 *  The scan only needs counts, not completeness. */
const SCAN_READ_CAP = 2 * 1024 * 1024;

/**
 * Count keyword occurrences (case-insensitive) per file by scanning each
 * eligible file's first `scanLimitBytes`, read as a BOUNDED prefix (open +
 * read at most SCAN_READ_CAP bytes; a multi-GB log never buffers whole).
 * ponytail: plain read + regex over matching lines (no native grep) — the
 * cascade's ranking only needs counts, and the walk is already
 * eligibility-bounded. Exported for tests.
 */
export async function grepIndex(rootAbs: string, rawKeywords: readonly string[], options: GrepIndexOptions): Promise<GrepIndex> {
  void rootAbs;
  const { open } = await import("node:fs/promises");
  const keywordsLower = rawKeywords.map((k) => k.toLowerCase()).filter((k) => k.length > 0);
  const index: GrepIndex = { keywords: keywordsLower, perFileKw: new Map(), filesScanned: 0 };
  if (keywordsLower.length === 0) return index;
  const re = new RegExp(keywordsLower.map(escapeRegex).join("|"), "gi");
  for (const [rel, abs] of options.files) {
    if (options.signal?.aborted) break;
    index.filesScanned++;
    let text: string;
    try {
      const cap = Math.min(options.scanLimitBytes ?? SCAN_LIMIT_DEFAULT, SCAN_READ_CAP);
      const fh = await open(abs, "r");
      try {
        const buf = Buffer.alloc(cap);
        const { bytesRead } = await fh.read(buf, 0, cap, 0);
        text = buf.subarray(0, bytesRead).toString("utf8");
      } finally {
        await fh.close();
      }
    } catch {
      continue; // unreadable — just unranked
    }
    let counts: number[] | undefined;
    for (const match of text.matchAll(re)) {
      if (!counts) counts = Array.from({ length: keywordsLower.length }, () => 0);
      const line = (match[0] ?? "").toLowerCase();
      for (let k = 0; k < keywordsLower.length; k++) {
        counts[k]! += countOccurrences(line, keywordsLower[k]!);
      }
    }
    if (counts) index.perFileKw.set(rel, counts);
  }
  return index;
}

/**
 * Inverse document frequency per keyword, clamped to `[0.5, 6]`: rarity is
 * capped so a word occurring once in a test fixture cannot beat an
 * implementation that contains several query concepts repeatedly.
 */
export function idf(index: GrepIndex): number[] {
  return index.keywords.map((_, k) => {
    let df = 0;
    for (const counts of index.perFileKw.values()) {
      if ((counts[k] ?? 0) > 0) df++;
    }
    const weight = Math.log((index.filesScanned + 1) / (df + 1));
    return Math.min(6, Math.max(0.5, weight));
  });
}

/**
 * Lexical rank of a file: rare query terms count more, log-scaled frequency
 * keeps common words in a giant file from overwhelming a compact
 * implementation with several terms, and a keyword in the path is worth two
 * extra log-units.
 */
export function fileScore(
  counts: readonly number[],
  weights: readonly number[],
  rel: string,
  keywordsList: readonly string[],
): number {
  const lower = rel.toLowerCase();
  let score = 0;
  for (let k = 0; k < keywordsList.length; k++) {
    const inPath = lower.includes(keywordsList[k]!) ? 1 : 0;
    score += weights[k]! * (2 * inPath + Math.log1p(counts[k] ?? 0));
  }
  return score;
}
