// ponytail: ported from oh-my-pi packages/coding-agent/src/tools/jfind
// {tree,passages}.ts — the eligible file walk (native glob → a plain
// .gitignore-respecting fs walk with the same deny-lists) and the
// byte-bounded source windows/sketches/heat merging.

import { lines, clipBytes, countOccurrences } from "./lexical.js";
import { execFileSync } from "node:child_process";
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

// ── eligibility deny-lists (tree.ts, verbatim) ──────────────────────────────

const DENY_DIRS: Record<string, true> = {
  ".git": true,
  node_modules: true,
  target: true,
  dist: true,
  build: true,
  out: true,
  ".next": true,
  ".nuxt": true,
  ".turbo": true,
  ".cache": true,
  __pycache__: true,
  ".venv": true,
  venv: true,
  ".tox": true,
  coverage: true,
  ".idea": true,
  ".vscode": true,
  ".gradle": true,
  ".mypy_cache": true,
  ".pytest_cache": true,
  ".ruff_cache": true,
  ".parcel-cache": true,
};

const DENY_FILES: Record<string, true> = {
  "Cargo.lock": true,
  "package-lock.json": true,
  "yarn.lock": true,
  "pnpm-lock.yaml": true,
  "bun.lock": true,
  "bun.lockb": true,
  "poetry.lock": true,
  "Pipfile.lock": true,
  "composer.lock": true,
  "Gemfile.lock": true,
  "go.sum": true,
  "flake.lock": true,
  ".DS_Store": true,
  "Thumbs.db": true,
};

const SECRET_FILES: Record<string, true> = {
  ".env": true,
  ".envrc": true,
  ".netrc": true,
  ".npmrc": true,
  ".pypirc": true,
  ".pgpass": true,
  ".boto": true,
  ".s3cfg": true,
  ".dockercfg": true,
  ".git-credentials": true,
  ".htpasswd": true,
  htpasswd: true,
  credentials: true,
  "credentials.json": true,
  "client_secret.json": true,
  "service-account.json": true,
  id_rsa: true,
  id_dsa: true,
  id_ecdsa: true,
  id_ed25519: true,
};

const SECRET_EXT = [
  "pem", "key", "p12", "pfx", "jks", "keystore", "bks", "ppk", "kdbx", "gpg", "pgp", "asc", "der",
  "crt", "cer", "tfvars", "tfvars.json", "tfstate", "tfstate.backup",
];

const BINARY_EXT = [
  "png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "bmp", "tiff", "psd", "svg", "woff", "woff2",
  "ttf", "otf", "eot", "zip", "gz", "tgz", "tar", "bz2", "xz", "zst", "7z", "rar", "pdf", "mp3",
  "mp4", "mov", "avi", "mkv", "wav", "ogg", "flac", "wasm", "so", "dylib", "dll", "exe", "o", "a",
  "class", "jar", "pyc", "pyo", "bin", "dat", "db", "sqlite", "sqlite3", "lock", "map", "min.js",
  "min.css", "snap", "pb", "onnx", "safetensors", "parquet", "arrow", "ipynb",
];

const ENV_TEMPLATES: Record<string, true> = {
  ".env.example": true,
  ".env.sample": true,
  ".env.template": true,
  ".env.dist": true,
};

function hasExt(lower: string, exts: readonly string[]): boolean {
  return exts.some((ext) => lower.length > ext.length && lower.endsWith(`.${ext}`));
}

/** Credential material: exact names, `.env.*` variants (except templates), key/vault extensions. */
function secret(name: string): boolean {
  if (Object.hasOwn(SECRET_FILES, name)) return true;
  if (name.startsWith(".env.")) return !Object.hasOwn(ENV_TEMPLATES, name);
  return hasExt(name.toLowerCase(), SECRET_EXT);
}

/** Whether a root-relative regular file is searchable. */
export function eligibleFile(rel: string, size: number, includeHidden: boolean): boolean {
  if (size <= 0) return false;
  const segments = rel.split("/");
  const name = segments[segments.length - 1]!;
  for (let i = 0; i < segments.length - 1; i++) {
    const dir = segments[i]!;
    if (Object.hasOwn(DENY_DIRS, dir) || (!includeHidden && dir.startsWith("."))) return false;
  }
  if (!includeHidden && name.startsWith(".")) return false;
  return !Object.hasOwn(DENY_FILES, name) && !secret(name) && !hasExt(name.toLowerCase(), BINARY_EXT);
}

/** One eligible file under the search root. */
export interface FileEntry {
  /** Absolute host path. */
  path: string;
  /** Root-relative display path with `/` separators. */
  rel: string;
  size: number;
}

/** ponytail: fixed-cap walk (3000 files) — gitignore-aware via `git ls-files`
 *  when inside a repo, plain walk otherwise; native glob not available. */
const LIST_CAP = 3000;

/** Every eligible file under `root` (directory), in path order. Symlinks are
 *  never followed; deny-lists mirror OMP's. Exported for tests. */
export function listFiles(rootAbs: string, includeHidden = false): FileEntry[] {
  // Prefer git's own view (respects .gitignore) when this is a checkout.
  const files: FileEntry[] = [];
  let gitFiles: string[] | undefined;
  try {
    gitFiles = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd: rootAbs,
      encoding: "utf8",
      timeout: 10_000,
    })
      .split("\n")
      .filter(Boolean);
  } catch {
    gitFiles = undefined; // not a repo / no git — plain walk below
  }
  if (gitFiles) {
    for (const rel of gitFiles) {
      if (files.length >= LIST_CAP) break;
      const abs = join(rootAbs, rel);
      let size = 0;
      try {
        size = statSync(abs).size;
      } catch {
        continue;
      }
      if (!eligibleFile(rel.replaceAll("\\", "/"), size, includeHidden)) continue;
      files.push({ path: abs, rel: rel.replaceAll("\\", "/"), size });
    }
    files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    return files;
  }
  const walk = (dir: string, relPrefix: string): void => {
    if (files.length >= LIST_CAP) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      if (files.length >= LIST_CAP) return;
      if (!includeHidden && name.startsWith(".")) continue;
      const abs = join(dir, name);
      const rel = relPrefix ? `${relPrefix}/${name}` : name;
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (Object.hasOwn(DENY_DIRS, name)) continue;
        walk(abs, rel);
      } else if (st.isFile()) {
        if (eligibleFile(rel, st.size, includeHidden)) files.push({ path: abs, rel, size: st.size });
      }
    }
  };
  walk(rootAbs, "");
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return files;
}

// ── passages (passages.ts, verbatim) ────────────────────────────────────────

/** A contiguous run of tagged source lines (`L<n>| text`), 1-based inclusive. */
export interface Passage {
  start: number;
  end: number;
  text: string;
  /** Lexical score used for window selection and tie-breaking. */
  score: number;
}

/** A judged line range with its yes-probability and a one-line preview. */
export interface HeatRange {
  start: number;
  end: number;
  p: number;
  snippet: string;
}

/** Contiguous whole-line windows bounded by bytes, including the final line. */
export function windows(text: string, bytes: number, keywords: readonly string[], weights: readonly number[]): Passage[] {
  const source = lines(text);
  const passages: Passage[] = [];
  let start = 0;
  while (start < source.length) {
    let end = start;
    let content = "";
    let used = 0;
    while (end < source.length) {
      const line = source[end]!;
      const prefix = `L${end + 1}| `;
      const overhead = prefix.length + 1;
      if (end > start && used + Buffer.byteLength(line) + overhead > bytes) break;
      const piece = `${prefix}${clipBytes(line, Math.max(0, bytes - (used + overhead)))}\n`;
      content += piece;
      used += Buffer.byteLength(piece);
      end++;
      if (used >= bytes) break;
    }
    const lower = content.toLowerCase();
    let score = 0;
    for (let k = 0; k < keywords.length; k++) {
      score += weights[k]! * Math.log1p(countOccurrences(lower, keywords[k]!));
    }
    passages.push({ start: start + 1, end, text: content, score });
    start = end;
  }
  return passages;
}

/**
 * Keep the best lexical windows and, when no words match, distribute the
 * budget evenly through the file instead of always falling back to its
 * opening bytes. Returned in file order.
 */
export function selectWindows(passages: Passage[], limit: number): Passage[] {
  let selected = passages;
  if (selected.length > limit) {
    if (selected.every((passage) => passage.score === 0)) {
      const len = selected.length;
      const step = Math.max(limit - 1, 1);
      const keep = new Set<number>();
      for (let k = 0; k < limit; k++) keep.add(Math.floor((k * (len - 1)) / step));
      selected = selected.filter((_, index) => keep.has(index));
    } else {
      selected = [...selected].sort((a, b) => b.score - a.score || a.start - b.start).slice(0, limit);
    }
  }
  return [...selected].sort((a, b) => a.start - b.start);
}

/** Passage text with the generated `L<n>| ` tags stripped. */
export function plainContent(passage: Passage): string {
  let out = "";
  const tagged = lines(passage.text);
  for (let i = 0; i < tagged.length; i++) {
    const line = tagged[i]!;
    const prefix = `L${passage.start + i}| `;
    out += `${line.startsWith(prefix) ? line.slice(prefix.length) : line}\n`;
  }
  return out;
}

/** Bytes reserved per selected sketch line for its `<line>: ` tag and separator. */
const SKETCH_LINE_OVERHEAD = 12;
/** Minimum bytes worth spending on one more sketch line. */
const SKETCH_MIN_LINE = 24;
/** Longest single sketch line. */
const SKETCH_MAX_LINE = 180;

/**
 * A budgeted map of verbatim source lines, not an invented summary. Lines are
 * ranked by keyword weight (plus a nudge for call-like lines) so deep
 * implementation text can outrank headers, then emitted in file order.
 */
export function sketch(passage: Passage, keywords: readonly string[], weights: readonly number[], budget: number): string {
  const plain = lines(plainContent(passage));
  const ranked: { index: number; score: number }[] = [];
  for (let index = 0; index < plain.length; index++) {
    const line = plain[index]!;
    if (line.trim().length === 0) continue;
    const lower = line.toLowerCase();
    let score = line.includes("(") ? 0.1 : 0;
    for (let k = 0; k < keywords.length; k++) {
      if (lower.includes(keywords[k]!)) score += weights[k]!;
    }
    ranked.push({ index, score });
  }
  ranked.sort((a, b) => b.score - a.score || a.index - b.index);
  const selected: { index: number; text: string }[] = [];
  let used = 0;
  for (const { index } of ranked) {
    const available = Math.max(0, budget - (used + SKETCH_LINE_OVERHEAD));
    if (available < SKETCH_MIN_LINE) break;
    const line = plain[index]!.trim();
    const text = `${passage.start + index}: ${clipBytes(line, Math.min(available, SKETCH_MAX_LINE))}`;
    used += Buffer.byteLength(text) + 1;
    selected.push({ index, text });
  }
  selected.sort((a, b) => a.index - b.index);
  return selected.map((entry) => entry.text).join("\n");
}

/** Read a file's text prefix; binary/empty are expected misses. */
export interface ReadText {
  text: string;
  truncated: boolean;
}

const BINARY_PROBE_BYTES = 8192;
/** ponytail: open + read at most this many bytes — a multi-GB file must not
 *  buffer whole before the maxBytes slice (the binary probe sits inside it). */
const READ_OPEN_CAP = 4 * 1024 * 1024;

/** Read up to `maxBytes` of a text file; rejects binaries and blank files.
 *  The underlying read is capped at READ_OPEN_CAP bytes regardless of maxBytes
 *  (beyond-cap callers already ask for ≤ READ_LIMIT, so only the OOM case
 *  changes); a short read at the cap flags `truncated`. */
export function readTextFile(absPath: string, maxBytes: number): ReadText {
  const want = Math.min(maxBytes, READ_OPEN_CAP);
  const fd = openSync(absPath, "r");
  let buf: Buffer;
  let total = 0;
  try {
    buf = Buffer.alloc(want);
    while (total < want) {
      const n = readSync(fd, buf, total, want - total, total);
      if (n === 0) break;
      total += n;
    }
    buf = buf.subarray(0, total);
  } finally {
    closeSync(fd);
  }
  const probe = buf.subarray(0, Math.min(buf.length, BINARY_PROBE_BYTES));
  if (probe.includes(0)) throw new Error("binary");
  const truncated = total >= want && (maxBytes > want || readSizeExceeds(absPath, want));
  if (truncated) {
    buf = buf.subarray(0, maxBytes);
    const newline = buf.lastIndexOf(0x0a);
    if (newline !== -1) buf = buf.subarray(0, newline + 1);
  }
  const text = buf.toString("utf8");
  if (lines(text).every((line) => line.trim().length === 0)) throw new Error("empty");
  return { text, truncated };
}

/** Size check for the exact-cap edge (read filled `want` — is there more?).
 *  Only consulted when maxBytes === the read cap. */
function readSizeExceeds(absPath: string, cap: number): boolean {
  try {
    return statSync(absPath).size > cap;
  } catch {
    return false;
  }
}

/**
 * Union the judged-positive spans; never bridge an unjudged gap. A merged
 * span keeps the max probability. Strongest first, then earliest.
 */
export function mergeHeat(heat: readonly HeatRange[], threshold: number): HeatRange[] {
  const kept = heat
    .filter((range) => range.p >= threshold && range.p > 0 && range.start <= range.end)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: HeatRange[] = [];
  for (const range of kept) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end);
      if (range.p > last.p) last.p = range.p;
      continue;
    }
    merged.push({ ...range });
  }
  return merged.sort((a, b) => b.p - a.p || a.start - b.start);
}

/** The most relevant ranges, strongest first, then earliest. */
export function rankedHeat(heat: readonly HeatRange[], limit: number): HeatRange[] {
  return heat
    .filter((range) => range.p > 0)
    .sort((a, b) => b.p - a.p || a.start - b.start)
    .slice(0, limit);
}
