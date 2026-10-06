// ponytail: ported from oh-my-pi packages/coding-agent/src/tools/jfind
// questions.ts — the three request shapes (filename batch, sketch batch,
// passage verification), each one state + one noul question per entry.
// OMP's prompt.render templates are inlined as template strings; the `Judge`
// interface is replaced by a minimal local one over modelRegistry.classify.

import { plainContent, type Passage, type HeatRange } from "./tree.js";
import type { FileEntry } from "./tree.js";

/** Minimal judge seam — implemented over modelRegistry.classify in
 *  judge.ts; tests inject a fake. */
export interface Judge {
  readonly label: string;
  judge(request: Request, options?: { signal?: AbortSignal }): Promise<JudgmentResult>;
}

/** One noul question (OMP judgment/types.ts shape, trimmed). */
export interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: { true?: string; false?: string };
}

export interface Request {
  state: Record<string, unknown>;
  questions: Record<string, NoulQuestion>;
}

export interface JudgmentResult {
  answers: Record<string, { probability?: number }>;
  usage?: { input?: number; output?: number };
}

const TASK =
  "Semantic grep over a source tree: locate files whose content matches the search description. Entries are judged by name, size, position in the tree, and (for folders) a sample of what they contain.";

const TREE_FORMAT =
  "`tree` is a directory listing. Lines starting with # are headers: `# dir/` is a folder; more #s means deeper nesting under the header above; a header may fold several levels (`# a/b/c/`). Every judgeable entry carries a tag like e017 right after the #s: files as `e017 name (size)`. Untagged header lines are only structure.";

const FILE_CRITERIA = {
  no: "The file is unrelated by name and location; generated executable implementation can still be relevant.",
  yes: "A file at this path plausibly contains code, text, or data matching the search.",
};

const SKETCH_CRITERIA = {
  no: "Unrelated code; mere mentions, declarations, call sites, tests or configuration without implementation.",
  yes: "Likely substantive implementation, definition or explanation of any part of the requested behavior. A matching helper for one step counts. Excerpts omit most source: favor recall.",
};

const PASSAGE_CRITERIA = {
  no: "This passage only mentions, calls, imports, tests, or configures the subject, or contains unrelated code sharing keywords.",
  yes: "This passage contains an implementation, definition, or substantive explanation of an important part of the search. A helper implementing one requested step counts even when other steps are elsewhere.",
};

/** Question key of the `i`th entry in a filename batch. */
export function entryKey(i: number): string {
  return `e${String(i).padStart(3, "0")}`;
}

/** Question key of the `k`th passage in a sketch or verification batch. */
export function passageKey(k: number): string {
  return `p${String(k).padStart(2, "0")}`;
}

/** Copy of `record` with keys in lexicographic order (wire parity with OMP). */
function sorted<T>(record: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of Object.keys(record).sort()) out[key] = record[key]!;
  return out;
}

const NAME_INSTRUCTIONS =
  'Is the file tagged {{key}} ("{{name}}") likely to contain what this search is looking for: "{{query}}"? Judge by its name, size, and place in `tree`; apply `criteria.file`.';

/** Model-facing listing of `entries` as a prefix-folded directory tree. */
function renderTree(entries: readonly FileEntry[], tagOf: (index: number) => string): string {
  // ponytail: flat prefix-fold without pi-utils' path-tree builder — group
  // by directory prefix, one # per depth.
  const lines: string[] = [];
  let lastDirs: string[] = [];
  entries.forEach((entry, index) => {
    const parts = entry.rel.split("/");
    const dirs = parts.slice(0, -1);
    let common = 0;
    while (common < dirs.length && common < lastDirs.length && dirs[common] === lastDirs[common]) common++;
    for (let d = common; d < dirs.length; d++) {
      if (lines.length > 0 && d === common) lines.push("");
      lines.push(`${"#".repeat(d + 2)} ${dirs[d]!}/`);
    }
    const name = parts[parts.length - 1]!;
    lines.push(`${"#".repeat(dirs.length + 2)} ${tagOf(index)} ${name} (${humanSize(entry.size)})`);
    lastDirs = dirs;
  });
  return lines.join("\n");
}

const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB"];

function humanSize(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${bytes} B` : `${value.toFixed(1)} ${SIZE_UNITS[unit]}`;
}

/** One noul per file over a shared tree-rendered listing of the batch. */
export function nameBatch(project: string, query: string, entries: readonly FileEntry[]): Request {
  const questions: Record<string, NoulQuestion> = {};
  entries.forEach((entry, i) => {
    const key = entryKey(i);
    const name = entry.rel.slice(entry.rel.lastIndexOf("/") + 1);
    questions[key] = {
      type: "noul",
      instructions: NAME_INSTRUCTIONS.replaceAll("{{key}}", key).replaceAll("{{name}}", name).replaceAll("{{query}}", query),
    };
  });
  return {
    state: {
      criteria: { file: FILE_CRITERIA },
      format: TREE_FORMAT,
      project,
      search: query,
      task: TASK,
      tree: renderTree(entries, entryKey),
    },
    questions,
  };
}

/** One sketch card: the file it came from and its budgeted verbatim lines. */
export interface SketchCard {
  fileKey: string;
  rel: string;
  sketch: string;
}

/** Mixed-file packing of sketch cards. */
export function sketchBatch(query: string, cards: readonly SketchCard[]): Request {
  const files: Record<string, string> = {};
  const passages: Record<string, [string, string]> = {};
  const questions: Record<string, NoulQuestion> = {};
  cards.forEach((card, k) => {
    const key = passageKey(k);
    files[card.fileKey] = card.rel;
    passages[key] = [card.fileKey, card.sketch];
    questions[key] = {
      type: "noul",
      instructions: `Could passage ${key} implement a requested step of search? Apply criteria.`,
    };
  });
  return {
    state: { criteria: SKETCH_CRITERIA, files: sorted(files), passages, search: query },
    questions,
  };
}

/** Verification of complete passages from one file, judged independently. */
export function passageBatch(query: string, rel: string, passages: readonly Passage[]): Request {
  const entries: Record<string, string> = {};
  const questions: Record<string, NoulQuestion> = {};
  passages.forEach((passage, k) => {
    const key = passageKey(k);
    entries[key] = plainContent(passage);
    questions[key] = {
      type: "noul",
      instructions: `Does \`passages.${key}\` substantively implement, define, or explain part of "${query}"? Apply \`criteria\`.`,
    };
  });
  return {
    state: { criteria: PASSAGE_CRITERIA, file: rel, passages: entries, search: query },
    questions,
  };
}

export type { HeatRange };
