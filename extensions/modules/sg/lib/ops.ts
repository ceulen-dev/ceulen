// sg ops — pure arg-building / parsing / formatting over the sg CLI facts
// (verified against ast-grep 0.45.3):
//   run -p PAT [-l LANG] [--globs G]… [PATHS…] --json=compact
//     → one JSON array of matches; exit 1 + "[]" = NO MATCHES (not an error);
//       stderr carrying "ERROR node" = the pattern failed to parse; exit 9 =
//       bad args (bad glob). range.start.line/column are 0-BASED.
//   run -p PAT -r REW … (no -U) → per-file diff preview (dry-run).
//   run -p PAT -r REW … -U      → writes files, prints NOTHING on success.

export interface SgMatch {
  file: string;
  /** 1-based (converted from sg's 0-based range). */
  line: number;
  column: number;
  text: string;
  /** Dedup key from sg's byte offsets. */
  byteStart: number;
}

export interface ParsedSg {
  matches: SgMatch[];
  noMatches: boolean;
  patternError?: string;
}

interface RawSgMatch {
  text?: string;
  file?: string;
  range?: { start?: { line?: number; column?: number }; end?: { line?: number; column?: number } };
}

/** Build `run` args for a search (or rewrite preview when rewrite given). */
export function buildRunArgs(opts: {
  pattern: string;
  rewrite?: string;
  language?: string;
  globs?: string[];
  paths?: string[];
  update?: boolean;
  json?: boolean;
}): string[] {
  const args = ["run", "-p", opts.pattern];
  if (opts.rewrite !== undefined) args.push("-r", opts.rewrite);
  if (opts.language) args.push("-l", opts.language);
  for (const g of opts.globs ?? []) args.push("--globs", g);
  if (opts.update) args.push("-U");
  if (opts.json) args.push("--json=compact");
  args.push(...(opts.paths && opts.paths.length > 0 ? opts.paths : ["."]));
  return args;
}

/** Parse a `--json=compact` search result. Exit 1 with an empty array is a
 *  NO-MATCH, not an error; a pattern-parse failure ("ERROR node" stderr on
 *  older sg, exit 8 + "Cannot parse query" on ast-grep 0.4x) is a
 *  patternError — the tools render it as a hint, not a tool crash. */
export function parseSearch(result: { exitCode: number; stdout: string; stderr: string }, pattern: string): ParsedSg {
  if (
    result.stderr.includes("ERROR node") ||
    (result.exitCode !== 0 && /Cannot parse query|Multiple AST nodes are detected/.test(result.stderr))
  ) {
    return { matches: [], noMatches: true, patternError: `pattern failed to parse: ${pattern}${firstLine(result.stderr)}` };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(result.stdout);
  } catch {
    throw new Error(`sg returned non-JSON output (exit ${result.exitCode}): ${result.stdout.slice(0, 200) || result.stderr.slice(0, 200)}`);
  }
  if (!Array.isArray(raw)) {
    throw new Error(`sg returned unexpected output (exit ${result.exitCode}): ${result.stdout.slice(0, 200)}`);
  }
  const matches = (raw as RawSgMatch[])
    .filter((m) => typeof m.file === "string")
    .map((m) => ({
      file: m.file!,
      // sg's range is 0-based — surface 1-based editor coordinates.
      line: (m.range?.start?.line ?? 0) + 1,
      column: (m.range?.start?.column ?? 0) + 1,
      text: m.text ?? "",
      byteStart: byteStartOf(m),
    }));
  return { matches, noMatches: matches.length === 0 };
}

function byteStartOf(m: RawSgMatch): number {
  const bo = (m as { range?: { byteOffset?: { start?: number } } }).range?.byteOffset?.start;
  if (typeof bo === "number") return bo;
  // Older sg without byteOffset: fall back to a file+position key (deduped
  // per-run anyway — cross-run dedupe just keeps both, harmless).
  return -1;
}

function firstLine(stderr: string): string {
  const line = stderr.split("\n").find((l) => l.trim().length > 0);
  return line ? ` (${line.trim().slice(0, 160)})` : "";
}

/** Merge sequential-run results, deduping by file + byte offset. */
export function mergeMatches(runs: ParsedSg[]): ParsedSg {
  const patternError = runs.find((r) => r.patternError)?.patternError;
  const seen = new Set<string>();
  const matches: SgMatch[] = [];
  for (const run of runs) {
    for (const m of run.matches) {
      const key = `${m.file}:${m.byteStart}`;
      if (m.byteStart >= 0 && seen.has(key)) continue;
      seen.add(key);
      matches.push(m);
    }
  }
  return { matches, noMatches: matches.length === 0 && !patternError, patternError };
}

/** Render matches: `path:line:col  text`. */
export function formatMatches(matches: SgMatch[], pattern: string, maxMatches = 200): string {
  if (matches.length === 0) return `no matches for ${pattern}`;
  const shown = matches.slice(0, maxMatches);
  const lines = shown.map((m) => {
    const text = m.text.length > 200 ? `${m.text.slice(0, 197)}…` : m.text;
    return `${m.file}:${m.line}:${m.column}  ${text.replaceAll("\n", "\\n")}`;
  });
  if (matches.length > shown.length) {
    lines.push(`… ${matches.length - shown.length} more (showing ${shown.length} of ${matches.length})`);
  }
  return lines.join("\n");
}

/** Split a dry-run diff preview into per-file sections (`path\n@@ …`). */
export function parseDiffOutput(stdout: string): Array<{ file: string; diff: string }> {
  const out: Array<{ file: string; diff: string }> = [];
  const lines = stdout.split("\n");
  let current: { file: string; lines: string[] } | undefined;
  for (const line of lines) {
    // File headers are bare relative paths (no @@, no gutter glyphs).
    if (line.length > 0 && !line.startsWith("@@") && !/^\s*[0-9]+\s*[│|]/.test(line) && !/^[│\-+ ]/.test(line) && line === line.trim() && !line.includes("│")) {
      if (current) out.push({ file: current.file, diff: current.lines.join("\n") });
      current = { file: line, lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) out.push({ file: current.file, diff: current.lines.join("\n") });
  return out;
}
