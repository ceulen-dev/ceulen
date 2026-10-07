// ponytail: ported from oh-my-pi packages/coding-agent/src/tools/jfind
// cascade.ts — the four-wave semantic find cascade (lexical scan → filename
// ranking → sketch routing → passage verification). The InternalUrlFilesystem
// and pi-natives scan are swapped for plain fs (listFiles/readTextFile in
// tree.ts + grepIndex in lexical.ts); everything else keeps OMP's shapes,
// budgets, and constants.

import { basename } from "node:path";
import { statSync } from "node:fs";
import {
  fileScore,
  grepIndex,
  idf,
  keywords as deriveKeywords,
  type GrepIndex,
} from "./lexical.js";
import {
  entryKey,
  passageKey,
  nameBatch,
  passageBatch,
  sketchBatch,
  type Judge,
  type Request,
  type SketchCard,
} from "./questions.js";
import {
  eligibleFile,
  listFiles,
  mergeHeat,
  plainContent,
  readTextFile,
  selectWindows,
  sketch,
  windows,
  type FileEntry,
  type HeatRange,
  type Passage,
} from "./tree.js";
import { lines, takeChars } from "./lexical.js";

/** Requests in flight per dispatched phase. */
const PARALLEL = 4;
/** Files per filename-ranking request. */
const NAME_BATCH = 64;
/** Lexically ranked files that receive a filename judgment. */
const CANDIDATES = 128;
/** Files whose content is read and sketched. */
const FILES = 20;
/** Windows kept per read file. */
const WINDOWS = 24;
/** Bytes per window, tags included. */
const WINDOW_BYTES = 8192;
/** Bytes per sketch card. */
const SKETCH_BYTES = 384;
/** Complete passages verified across all files. */
const FULL_LIMIT = 40;
/** Sketch probability below which a passage is not verified. */
const CUTOFF = 0.45;
/** Verified-passage probability at or above which a file is a hit. */
const THRESHOLD = 0.2;
/** Bytes of a file read for windowing. */
const READ_LIMIT = 4 * 1024 * 1024;
/** Sketch state budget per request. */
const SKETCH_STATE_BYTES = 18_000;
/** Hard cap on sketch cards per request. */
const SKETCH_CARDS_MAX = 48;
/** Passage state budget per verification request, tags included. */
const VERIFY_STATE_BYTES = 24 * 1024;
/** Distinct failure messages retained for the report. */
const FAILURES_KEPT = 5;
/** ponytail: classify round-trips are costlier than OMP's native judge, so
 *  the budget tightened from 20s; a stalled judge fails instead of blocking. */
export const FIND_TIMEOUT_MS = 45_000;

export interface FindHit {
  rel: string;
  nameScore?: number;
  contentScore: number;
  ranges: HeatRange[];
  linesSeen: number;
  truncated: boolean;
}

export interface FindStats {
  listed: number;
  requests: number;
  errors: number;
  judged: number;
  filesRead: number;
  fileBytes: number;
  inputTokens: number;
  outputTokens: number;
  windowsJudged: number;
  windowsPruned: number;
  mapCards: number;
  failures: string[];
}

export interface CascadeOptions {
  root: string;
  query: string;
  extraKeywords: readonly string[];
  judge: Judge;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface CascadeResult {
  hits: FindHit[];
  threshold: number;
  keywords: string[];
  stats: FindStats;
}

interface FilePlan {
  node: number;
  total: number;
  truncated: boolean;
  passages: Passage[];
}

type Outcome = { ok: true; result: { answers: Record<string, { probability?: number }>; usage?: { input?: number; output?: number } } } | { ok: false; error: unknown };

function noul(outcome: Outcome, key: string): number | undefined {
  if (!outcome.ok) return undefined;
  const p = outcome.result.answers[key]?.probability;
  return p !== undefined && Number.isFinite(p) && p >= 0 && p <= 1 ? p : undefined;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += size) out.push(items.slice(start, start + size));
  return out;
}

function compareRel(a: FileEntry, b: FileEntry): number {
  return a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0;
}

class Cascade {
  readonly #options: CascadeOptions;
  readonly stats: FindStats = {
    listed: 0,
    requests: 0,
    errors: 0,
    judged: 0,
    filesRead: 0,
    fileBytes: 0,
    inputTokens: 0,
    outputTokens: 0,
    windowsJudged: 0,
    windowsPruned: 0,
    mapCards: 0,
    failures: [],
  };

  constructor(options: CascadeOptions) {
    this.#options = options;
  }

  #fail(phase: string, error: unknown): void {
    const message = `${phase}: ${error instanceof Error ? error.message : String(error)}`;
    const { failures } = this.stats;
    if (failures.length < FAILURES_KEPT && !failures.includes(message)) failures.push(message);
  }

  async #ask(request: Request): Promise<Outcome> {
    const { judge, signal } = this.#options;
    try {
      const result = await judge.judge(request, { signal });
      this.stats.requests++;
      this.stats.inputTokens += result.usage?.input ?? 0;
      this.stats.outputTokens += result.usage?.output ?? 0;
      return { ok: true, result };
    } catch (error) {
      if (this.#options.signal?.aborted) throw error;
      this.stats.requests++;
      this.stats.errors++;
      return { ok: false, error };
    }
  }

  /** At most PARALLEL requests in flight; drains fully before the next phase. */
  async #dispatch<J extends { request: Request }>(jobs: readonly J[], settle: (job: J, outcome: Outcome) => void): Promise<void> {
    let next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        if (this.#options.signal?.aborted) throw new Error("aborted");
        const job = jobs[next++]!;
        settle(job, await this.#ask(job.request));
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, jobs.length) }, worker));
  }

  async run(): Promise<CascadeResult> {
    const { root, query, judge: _judge, signal, onProgress } = this.#options;
    const keywords = deriveKeywords(query, this.#options.extraKeywords);

    onProgress?.("lexical scan");
    const entries = scopeFiles(root);
    const fileMap = new Map(entries.map((e) => [e.rel, e.path]));
    const index: GrepIndex = await grepIndex(root, keywords, { files: fileMap, signal });
    this.stats.listed = entries.length;
    const weights = idf(index);
    const noCounts = Array.from({ length: keywords.length }, () => 0);
    const ranked = entries
      .map((entry, node) => ({
        node,
        lex: fileScore(index.perFileKw.get(entry.rel) ?? noCounts, weights, entry.rel, keywords),
      }))
      .sort((a, b) => b.lex - a.lex || compareRel(entries[a.node]!, entries[b.node]!))
      .slice(0, CANDIDATES);
    const nameScore = Array.from<number | undefined>({ length: entries.length });

    // Wave 1: filename ranking over the lexical shortlist.
    const project = basename(root);
    const nameJobs = chunks(
      ranked.map((candidate) => candidate.node),
      NAME_BATCH,
    ).map((batch) => ({
      batch,
      request: nameBatch(project, query, batch.map((node) => entries[node]!)),
    }));
    let named = 0;
    onProgress?.(`filename ranking 0/${ranked.length}`);
    await this.#dispatch(nameJobs, (job, outcome) => {
      named += job.batch.length;
      if (!outcome.ok) this.#fail("filenames", outcome.error);
      job.batch.forEach((node, k) => {
        const p = noul(outcome, entryKey(k));
        nameScore[node] = p;
        if (p === undefined) {
          if (outcome.ok) this.stats.errors++;
        } else {
          this.stats.judged++;
        }
      });
      onProgress?.(`filename ranking ${named}/${ranked.length}`);
    });

    // The two strongest lexical candidates are read regardless of the name
    // judgment; the rest of the budget follows name score, then lexical rank.
    const selected = ranked.slice(0, Math.min(FILES, 2)).map((candidate) => candidate.node);
    ranked.sort((a, b) => (nameScore[b.node] ?? 0) - (nameScore[a.node] ?? 0) || b.lex - a.lex);
    for (const candidate of ranked) {
      if (selected.length >= FILES) break;
      if (!selected.includes(candidate.node)) selected.push(candidate.node);
    }
    onProgress?.(`reading ${selected.length} files`);
    const plans: (FilePlan | undefined)[] = await Promise.all(
      selected.map(async (node): Promise<FilePlan | undefined> => {
        const entry = entries[node]!;
        try {
          const read = readTextFile(entry.path, READ_LIMIT);
          const passages = selectWindows(windows(read.text, WINDOW_BYTES, keywords, weights), WINDOWS);
          if (passages.length === 0) return undefined;
          return { node, total: lines(read.text).length, truncated: read.truncated, passages };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          if (msg !== "binary" && msg !== "empty") this.#fail(`read ${entry.rel}`, error);
          return undefined;
        }
      }),
    );
    const files = plans.filter((plan): plan is FilePlan => plan !== undefined);

    // Wave 2: sketch routing over mixed-file cards.
    const cards: { f: number; p: number }[] = [];
    files.forEach((plan, f) => plan.passages.forEach((_, p) => cards.push({ f, p })));
    const sketchJobs = chunks(
      cards,
      Math.min(SKETCH_CARDS_MAX, Math.max(1, Math.floor(SKETCH_STATE_BYTES / SKETCH_BYTES))),
    ).map((batch) => {
      const sketches: SketchCard[] = batch.map(({ f, p }) => ({
        fileKey: `f${f}`,
        rel: entries[files[f]!.node]!.rel,
        sketch: sketch(files[f]!.passages[p]!, keywords, weights, SKETCH_BYTES),
      }));
      return { batch, request: sketchBatch(query, sketches) };
    });
    this.stats.mapCards += cards.length;
    onProgress?.(`scoring ${cards.length} passage sketches across ${files.length} files`);
    const candidates: { f: number; p: number; score: number }[] = [];
    await this.#dispatch(sketchJobs, (job, outcome) => {
      if (!outcome.ok) this.#fail("sketches", outcome.error);
      job.batch.forEach(({ f, p }, k) => {
        const score = noul(outcome, passageKey(k));
        if (score === undefined && outcome.ok) this.stats.errors++;
        // Failure is unknown, never grounds for a negative judgment.
        candidates.push({ f, p, score: score ?? 1 });
      });
    });
    candidates.sort(
      (a, b) =>
        b.score - a.score ||
        files[b.f]!.passages[b.p]!.score - files[a.f]!.passages[a.p]!.score ||
        compareRel(entries[files[a.f]!.node]!, entries[files[b.f]!.node]!) ||
        files[a.f]!.passages[a.p]!.start - files[b.f]!.passages[b.p]!.start,
    );
    const survivors = candidates.filter((candidate) => candidate.score >= CUTOFF).slice(0, FULL_LIMIT);
    this.stats.windowsPruned += cards.length - survivors.length;
    const chosen = new Map<number, number[]>();
    for (const { f, p } of survivors) {
      const list = chosen.get(f);
      if (list) list.push(p);
      else chosen.set(f, [p]);
    }

    // Wave 3: verification of complete passages, grouped per file.
    const verifyJobs: { f: number; passages: Passage[]; request: Request }[] = [];
    for (const f of [...chosen.keys()].sort((a, b) => a - b)) {
      const rel = entries[files[f]!.node]!.rel;
      const ps = chosen.get(f)!.sort((a, b) => a - b);
      for (const group of chunks(ps, Math.max(1, Math.floor(VERIFY_STATE_BYTES / WINDOW_BYTES)))) {
        const passages = group.map((p) => files[f]!.passages[p]!);
        verifyJobs.push({ f, passages, request: passageBatch(query, rel, passages) });
      }
    }
    onProgress?.(`verifying ${survivors.length} passages in ${chosen.size} files`);
    const results = new Map<number, { score: number; heat: HeatRange[]; lines: number; bytes: number }>();
    await this.#dispatch(verifyJobs, (job, outcome) => {
      if (!outcome.ok) {
        this.#fail("verification", outcome.error);
        return;
      }
      let entry = results.get(job.f);
      if (!entry) {
        entry = { score: 0, heat: [], lines: 0, bytes: 0 };
        results.set(job.f, entry);
      }
      job.passages.forEach((passage, k) => {
        const score = noul(outcome, passageKey(k));
        if (score === undefined) {
          this.stats.errors++;
          return;
        }
        const text = plainContent(passage);
        entry.score = Math.max(entry.score, score);
        entry.heat.push({
          start: passage.start,
          end: passage.end,
          p: score,
          snippet: takeChars(lines(text).find((line) => line.trim().length > 0) ?? "", 100),
        });
        entry.lines += passage.end - passage.start + 1;
        entry.bytes += Buffer.byteLength(text);
        this.stats.windowsJudged++;
      });
    });

    const hits: FindHit[] = [];
    for (const [f, entry] of results) {
      const plan = files[f]!;
      this.stats.filesRead++;
      this.stats.fileBytes += entry.bytes;
      if (entry.score < THRESHOLD) continue;
      hits.push({
        rel: entries[plan.node]!.rel,
        nameScore: nameScore[plan.node],
        contentScore: entry.score,
        ranges: mergeHeat(entry.heat, THRESHOLD),
        linesSeen: entry.lines,
        truncated: plan.truncated || entry.lines < plan.total,
      });
    }
    this.stats.filesRead += files.length - results.size;
    hits.sort((a, b) => b.contentScore - a.contentScore);
    return { hits, threshold: THRESHOLD, keywords, stats: this.stats };
  }
}

/** The lexical/judging cascade runs over a file LIST; a single-file `path`
 *  scope used to list zero files and report "no hits" silently. Wrap it as a
 *  one-entry walk so the documented scope works. Exported for tests. */
export function scopeFiles(root: string): FileEntry[] {
  const st = statSync(root);
  if (!st.isDirectory()) {
    const rel = basename(root);
    return eligibleFile(rel, st.size, rel.startsWith(".")) ? [{ path: root, rel, size: st.size }] : [];
  }
  return listFiles(root);
}

/** One cascade search. Judge failures degrade coverage and land in
 *  `stats.failures` — never thrown. */
export function runCascade(options: CascadeOptions): Promise<CascadeResult> {
  return new Cascade(options).run();
}

