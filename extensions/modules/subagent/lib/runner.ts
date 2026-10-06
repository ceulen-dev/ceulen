// ponytail: vendored from @bacnh85/pi-subagent 0.23.2 (extensions/runner.ts).
// ceulen delta: hardTimeoutMs <= 0 arms NO hard timer — the cap is opt-in
// (subagent.hardTimeoutMins, 0=off); the idle timer is the hang detector.
/**
 * SDK-based sub-agent runner for pi-subagent.
 *
 * Creates an in-process AgentSession via the pi SDK instead of spawning a
 * separate `pi` process. This eliminates cold-start overhead and allows
 * fine-grained control over token budget:
 *
 *   - Only the agent's system prompt is used (no pi defaults).
 *   - No AGENTS.md, no extensions, no skills, no prompt templates loaded.
 *   - Thinking disabled, compaction disabled, one transient retry.
 *   - In-memory session (no disk I/O).
 *   - Shared auth/model infrastructure (no re-connection).
 *
 * Estimated token savings vs process-spawn: ~4-11K tokens per invocation.
 */

import type { Message, Model } from "./types.ts";
import type { AgentMessage } from "./types.ts";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  createAgentSession,
  createExtensionRuntime,
  DefaultResourceLoader,
  getAgentDir,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  classifyStopReason,
  createCombinedAbortSignal,
  type SubagentStatus,
  DEFAULT_TIMEOUT_MS,
  HARD_TIMEOUT_MS,
  truncateParallelOutput,
} from "./security.ts";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

/** Re-export from security.ts — single source of truth for both timeouts. */
export const DEFAULT_INACTIVITY_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;
export { HARD_TIMEOUT_MS };


// ---------------------------------------------------------------------------
// Extension resource loader
// ---------------------------------------------------------------------------

/**
 * Build a FRESH lean DefaultResourceLoader for this child — no skills, prompt
 * templates, context files (AGENTS.md), or themes. Extensions are loaded per
 * child so their factories run against a runtime that THIS child's session will
 * bind.
 *
 * Do NOT cache/share this loader. Extensions capture the ExtensionAPI (`pi`)
 * at factory load time, and its actions delegate to the runtime passed to the
 * factory (see createExtensionAPI: pi.getAllTools() → runtime.getAllTools()).
 * If extensions were loaded once against a shared/cached runtime, that runtime
 * is never the one any single child binds: a session binds the runtime its own
 * getExtensions() returned (AgentSession constructor), while the factory-captured
 * pi still points at the shared runtime. A child then hits the runtime's throwing
 * "Extension runtime not initialized" stubs on the first provider request
 * (pi-model-tools' before_provider_request calls pi.getAllTools()), or stale-ctx
 * errors when the shared runtime is invalidated by the first child's dispose.
 * A per-child loader keeps every captured `pi` pointing at a runtime this child
 * both binds and owns.
 *
 * Project-extension trust is resolved from the parent (`projectTrusted`) so a
 * child never prompts for trust (it has no UI). reload() per child re-reads
 * extension files + re-runs factories; acceptable for short-lived children.
 */
async function getExtensionLoader(cwd: string, projectTrusted: boolean): Promise<ResourceLoader> {
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
    noThemes: true,
  });
  await loader.reload({ resolveProjectTrust: async () => projectTrusted });
  // Log (don't throw on) extension load errors — a misbehaving extension must
  // not crash the child; the agent simply won't have that tool.
  const loadErrors = loader.getExtensions().errors;
  if (loadErrors.length > 0) {
    process.stderr.write(
      `[pi-subagent] extension load warnings in child loader: ${loadErrors.map((e) => `${e.path}: ${e.error}`).join("; ")}\n`,
    );
  }
  return loader;
}

export interface SubAgentProgress {
  label: string;
  at: number;
  elapsedMs: number;
  inactivityDeadline: number;
  hardDeadline: number;
  result: SubAgentResult;
}

export interface SubAgentResult {
  agent: string;
  task: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  /** Thinking level the child actually ran with (after routing/pins). */
  thinking?: string;
  /** Steered advisor revisions folded into this result (herdr runner waited
   *  for the child's own advisor before collecting — see lib/herdr.ts). */
  advisorRounds?: number;
  stopReason?: string;
  errorMessage?: string;
  /** Unified diff of changes made in an isolated worktree (sandbox: "worktree"). */
  patch?: string;
  /** Set when merge:"3way" was requested: outcome of applying the patch to the parent checkout. */
  mergeStatus?: "applied" | "conflict";
  /** git apply error excerpt when mergeStatus === "conflict". */
  mergeError?: string;
  /** Canonical result status (added in 0.6.0). */
  status?: SubagentStatus;
  /** Wall-clock duration of the run, set by runSubAgent (Date.now() - startedAt). */
  durationMs?: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function startHeartbeat(onHeartbeat: () => void, intervalMs = 30_000): () => void {
  const timer = setInterval(onHeartbeat, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export async function runSubAgent(options: {
  cwd: string;
  systemPrompt: string;
  task: string;
  tools: string[];
  model: Model;
  /** "worktree" runs the child in an isolated git worktree; the resulting diff is returned as result.patch. */
  sandbox?: "worktree";
  /** With sandbox:"worktree", apply the captured diff to the parent checkout via `git apply --3way` after the run. */
  merge?: "3way";
  /** Pi 0.80.10's canonical credential/model runtime. */
  modelRuntime?: unknown;
  /** Legacy Pi SDK session options retained for 0.80.6 tests and hosts. */
  authStorage?: unknown;
  modelRegistry?: unknown;
  signal?: AbortSignal;
  agentName?: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  onMessage?: (partialResult: SubAgentResult) => void;
  onProgress?: (progress: SubAgentProgress) => void;
  timeoutMs?: number;
  hardTimeoutMs?: number;
  /** Exec used for the git worktree lifecycle (add/remove/diff). Defaults to a child_process spawn when unset. */
  exec?: (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => Promise<{ code: number; stdout: string; stderr: string }>;
  /**
   * When true, build a DefaultResourceLoader so the child inherits the parent's
   * extensions (and thus extension tools: web, serena, munin, …). When false or
   * unset, the lean empty-loader stub is used (no extensions).
   */
  loadExtensions?: boolean;
  /**
   * Whether the parent session trusts the project. Forwarded to the loader's
   * resolveProjectTrust so children inherit the parent's trust decision and
   * never prompt for project-extension trust (children have no UI). Defaults true.
   */
  projectTrusted?: boolean;
}): Promise<SubAgentResult> {
  const {
    cwd, systemPrompt, task, tools, model, modelRuntime, authStorage, modelRegistry, signal,
    agentName = "subagent", thinkingLevel = "off", onMessage, onProgress,
    timeoutMs = DEFAULT_INACTIVITY_TIMEOUT_MS, hardTimeoutMs = HARD_TIMEOUT_MS,
    loadExtensions = false, projectTrusted = true, sandbox, merge, exec,
  } = options;
  const result: SubAgentResult = {
    agent: agentName, task, exitCode: 0, messages: [], stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    model: `${model.provider}/${model.id}`, status: undefined,
    thinking: thinkingLevel,
  };
  const resourceLoader: ResourceLoader = loadExtensions
    ? await getExtensionLoader(cwd, projectTrusted)
    : {
        getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
        getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
        getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
        getSystemPrompt: () => systemPrompt, getSystemPromptSource: () => undefined,
        getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
        extendResources: () => {}, reload: async () => {},
      };
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 1 } });
  const startedAt = Date.now();
  let inactivityDeadline = startedAt + timeoutMs;
  const hardDeadline = startedAt + hardTimeoutMs;
  let timeoutKind: "idle" | "hard" | undefined;
  const timeoutController = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  let cleanupCombined: (() => void) | undefined;
  const clearTimers = () => { if (idleTimer) clearTimeout(idleTimer); if (hardTimer) clearTimeout(hardTimer); };
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    inactivityDeadline = Date.now() + timeoutMs;
    idleTimer = setTimeout(() => { timeoutKind = "idle"; timeoutController.abort(new Error(`Idle timeout after ${timeoutMs}ms`)); }, timeoutMs);
  };
  const snapshot = (label: string): SubAgentProgress => ({ label, at: Date.now(), elapsedMs: Date.now() - startedAt, inactivityDeadline, hardDeadline, result: { ...result, messages: [...result.messages] } });
  try {
    armIdle();
    // ceulen: hardTimeoutMs <= 0 (subagent.hardTimeoutMins: 0, the default) arms
    // NO hard timer — a child producing events is never hard-killed. The idle
    // timer above is the hang detector.
    if (hardTimeoutMs > 0) {
      hardTimer = setTimeout(() => { timeoutKind = "hard"; timeoutController.abort(new Error(`Hard timeout after ${hardTimeoutMs}ms`)); }, hardTimeoutMs);
    }
    const { signal: combinedSignal, cleanup } = createCombinedAbortSignal([signal, timeoutController.signal]);
    cleanupCombined = cleanup;
    if (combinedSignal.aborted) {
      result.exitCode = 1;
      const timedOut = timeoutController.signal.aborted && !signal?.aborted;
      result.stopReason = timedOut ? "timeout" : "aborted";
      result.errorMessage = timedOut ? `${timeoutKind === "idle" ? "Idle" : "Hard"} timeout after ${timeoutKind === "idle" ? timeoutMs : hardTimeoutMs}ms` : "Sub-agent aborted before start";
      result.status = classifyStopReason(result.stopReason, !timedOut, timedOut);
      return result;
    }

    // Isolated git worktree: the child edits a sibling checkout; the resulting
    // diff is returned as result.patch and the worktree is removed on exit.
    // ponytail: falls back to the in-process cwd when git is unavailable — the
    // worktree is an isolation optimization, not a hard requirement.
    let worktreeDir: string | undefined;
    let worktreeRepoRoot: string | undefined;
    let childCwd = cwd;
    if (sandbox === "worktree") {
      const wt = await createWorktree(cwd, exec);
      if (wt.ok) {
        worktreeDir = wt.path;
        worktreeRepoRoot = wt.repoRoot;
        childCwd = wt.path!;
        // Seed the parent's uncommitted state into a git-worktree fallback
        // (the CoW copy already IS the working tree). Read-only capture; the
        // child's delta (diff vs HEAD) then carries baseline + edits, which
        // 3-way-merges cleanly onto a parent that holds the same baseline —
        // conflicts surface only genuine mid-run parent changes.
          if (wt.cow === false && worktreeRepoRoot && worktreeDir) {
          const baseline = await captureParentBaseline(worktreeRepoRoot, exec);
          if (baseline.ok && baseline.patch && baseline.patch.trim()) {
            const applied = await applyBaselineToWorktree(worktreeDir, baseline.patch, exec);
            if (!applied.ok) {
              const note = `Baseline carry failed (${applied.error?.slice(0, 200)}); child runs on clean HEAD.`;
              result.stderr = result.stderr ? `${result.stderr}; ${note}` : note;
            }
          } else if (!baseline.ok && baseline.error) {
            const note = `Baseline capture failed (${baseline.error.slice(0, 200)}); child runs on clean HEAD.`;
            result.stderr = result.stderr ? `${result.stderr}; ${note}` : note;
          }
          await copyWorktreeIncludes(worktreeRepoRoot, worktreeDir).catch(() => { /* best effort */ });
        }
      } else if (wt.error) {
        result.stderr = `Worktree unavailable (${wt.error}); running in workspace.`;
      }
    }

    let session: Awaited<ReturnType<typeof createAgentSession>>["session"];
    try {
      const created = await createAgentSession({
        cwd: childCwd, model, thinkingLevel, resourceLoader, tools, sessionManager: SessionManager.inMemory(childCwd), settingsManager,
        ...(modelRuntime ? { modelRuntime } : {}),
        // Pi 0.80.10 owns credentials in ModelRuntime; older SDKs still accept these.
        ...(authStorage ? { authStorage, modelRegistry } : {}),
      } as any);
      session = created.session;
    } catch (error) {
      // Lock on the RESOLVED repo root (createWorktree/applyWorktreePatch3way do): a
      // child dispatched with a subdirectory cwd must not key the per-repo lock
      // differently — parallel siblings would race git's O_EXCL index.lock.
      if (worktreeDir) await removeWorktree(worktreeRepoRoot ?? cwd, worktreeDir, exec);
      throw error;
    }
    let unsubscribe: (() => void) | undefined;
    let removeAbort: (() => void) | undefined;
    try {
      const eventDone = new Promise<void>((resolve, reject) => {
        let done = false;
        const finish = (fn: () => void) => { if (!done) { done = true; unsubscribe?.(); fn(); } };
        unsubscribe = session.subscribe((event) => {
          try {
            // Any SDK session event — including message_update streaming
            // deltas (thinking_delta/text_delta) — is real child activity
            // and resets the idle timer. Only a stream with NO events at all
            // for timeoutMs indicates a hung child.
            armIdle(); onProgress?.(snapshot(event.type));
            if (event.type === "message_end") {
              const msg = event.message as AgentMessage;
              if (msg.role === "assistant") {
                result.usage.turns++;
                if (msg.usage) { result.usage.input += msg.usage.input || 0; result.usage.output += msg.usage.output || 0; result.usage.cacheRead += msg.usage.cacheRead || 0; result.usage.cacheWrite += msg.usage.cacheWrite || 0; result.usage.cost += msg.usage.cost?.total || 0; result.usage.contextTokens = msg.usage.totalTokens || 0; }
                if (!result.model && msg.model) result.model = `${msg.provider || "?"}/${msg.model}`;
                if (msg.stopReason) result.stopReason = msg.stopReason;
                result.errorMessage = msg.errorMessage;
              }
              result.messages.push(msg as unknown as Message);
              onMessage?.({ ...result, messages: [...result.messages] });
            } else if (event.type === "agent_end" && !event.willRetry) {
              if (!result.messages.length && event.messages) result.messages = event.messages as unknown as Message[];
              finish(resolve);
            }
          } catch (error) { finish(() => reject(error)); }
        });
        const abort = () => finish(resolve);
        combinedSignal.addEventListener("abort", abort, { once: true });
        removeAbort = () => combinedSignal.removeEventListener("abort", abort);
      });
      const abortSession = () => session.abort();
      combinedSignal.addEventListener("abort", abortSession, { once: true });
      const removeSessionAbort = () => combinedSignal.removeEventListener("abort", abortSession);
      await Promise.race([session.prompt(task), eventDone]);
      removeSessionAbort();
      const timedOut = timeoutController.signal.aborted && !signal?.aborted;
      if (timedOut) { result.stopReason = "timeout"; result.errorMessage = `${timeoutKind === "idle" ? "Idle" : "Hard"} timeout after ${timeoutKind === "idle" ? timeoutMs : hardTimeoutMs}ms`; }
      else if (combinedSignal.aborted) { result.stopReason = "aborted"; result.errorMessage ||= "Sub-agent aborted"; }
      result.status = classifyStopReason(result.stopReason, result.stopReason === "aborted", result.stopReason === "timeout");
      result.exitCode = result.status === "success" || result.status === "partial" ? 0 : 1;
      if (worktreeDir) {
        // Capture the child's changes as a unified diff before tearing down.
        const diff = await captureWorktreeDiff(cwd, worktreeDir, exec);
        if (diff.ok) {
          result.patch = diff.diff;
          // Opt-in 3-way merge: apply while the worktree still exists — the
          // blobs `git add -A` staged live in the shared object DB and
          // `git apply --3way` needs them. Applies are serialized (see
          // applyWorktreePatch3way) so parallel siblings cannot race. Only
          // successfully completed children auto-merge: a timed-out or
          // aborted child's half-finished edits must not land on the parent
          // checkout — their patch is still delivered for manual review.
          if (merge === "3way" && result.status === "success" && worktreeRepoRoot && diff.diff && diff.diff !== "(no changes)") {
            const applied = await applyWorktreePatch3way(worktreeRepoRoot, diff.diff, exec);
            if (applied.ok) {
              result.mergeStatus = "applied";
            } else {
              result.mergeStatus = "conflict";
              result.mergeError = applied.stderr.slice(0, 1000);
            }
          }
        }
        else if (diff.error) result.stderr = result.stderr ? `${result.stderr}; diff unavailable (${diff.error})` : `Diff unavailable (${diff.error})`;
      }
      return result;
    } finally {
      unsubscribe?.(); removeAbort?.();
      try { session.dispose(); } catch { /* best effort */ }
      // Lock on the RESOLVED repo root (createWorktree/applyWorktreePatch3way do): a
      // child dispatched with a subdirectory cwd must not key the per-repo lock
      // differently — parallel siblings would race git's O_EXCL index.lock.
      if (worktreeDir) await removeWorktree(worktreeRepoRoot ?? cwd, worktreeDir, exec);
    }
  } catch (error) {
    result.exitCode = 1;
    result.errorMessage = error instanceof Error ? error.message : String(error);
    result.stopReason ||= "error";
    result.status = classifyStopReason(result.stopReason, false, false);
    return result;
  } finally {
    clearTimers(); cleanupCombined?.();
    result.durationMs = Date.now() - startedAt;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal exec fallback (child_process spawn) used when no exec is injected. */
export async function defaultExec(
  command: string,
  args: string[],
  options?: { cwd?: string; timeout?: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options?.cwd, stdio: ["ignore", "pipe", "pipe"] });
    // Decode each chunk as a complete UTF-8 stream (Buffer.toString per chunk
    // would corrupt multi-byte sequences straddling chunk boundaries).
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = ""; let stderr = "";
    const timer = options?.timeout ? setTimeout(() => child.kill("SIGKILL"), options.timeout) : undefined;
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (err) => { if (timer) clearTimeout(timer); resolve({ code: 1, stdout, stderr: String(err.message ?? err) }); });
    child.on("close", (code) => { if (timer) clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
  });
}

async function runGit(
  cwd: string,
  args: string[],
  exec?: (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => Promise<{ code: number; stdout: string; stderr: string }>,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const run = exec ?? defaultExec;
  const res = await run("git", args, { cwd, timeout: 30_000 });
  return { ok: res.code === 0, stdout: res.stdout, stderr: res.stderr };
}

/** Per-repo serialization for git operations that mutate the SHARED parent
 *  `.git` (worktree add/remove registry, `git apply`'s index/ODB writes).
 *  Git's own locks are O_EXCL with no waiter — concurrent mutations fail
 *  instantly instead of blocking (OMP withRepoLock precedent), so callers
 *  that can collide must queue here. Keyed by repo root so parallel repos
 *  stay independent; a failing block does not poison the queue. */
const repoLocks = new Map<string, Promise<unknown>>();

export async function withRepoLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(repoRoot);
  const prior = repoLocks.get(key) ?? Promise.resolve();
  const run = prior.then(fn, fn);
  // The stored chain swallows errors so the NEXT caller starts clean; the
  // returned promise still propagates this block's error to its own caller.
  const stored = run.then(() => undefined, () => undefined);
  repoLocks.set(key, stored);
  // Drop the key once idle so the map cannot grow unboundedly across repos.
  // A concurrent waiter has already replaced the stored chain by then.
  stored.then(() => { if (repoLocks.get(key) === stored) repoLocks.delete(key); });
  return run;
}

/** Owner marker written into every worktree sandbox: lets the GC sweep tell a
 *  live session's sandbox from a crashed run's leftover. */
export interface WorktreeOwner {
  pid: number;
  id: string;
  createdAt: number;
}

export const WORKTREE_DIR_NAME = ".pi-worktrees";

/** A nested `.gitignore` (content `*`) inside the sandbox base keeps sandboxes
 *  out of the parent's `git status` AND out of untracked baseline capture —
 *  without touching the user's own .gitignore. */
async function ensureWorktreeBaseGitignore(base: string): Promise<void> {
  const ignoreFile = path.join(base, ".gitignore");
  try {
    await fs.mkdir(base, { recursive: true });
    await fs.writeFile(ignoreFile, "*\n", { flag: "wx" });
  } catch { /* exists (or unwritable) — either is fine */ }
}

/** Owner marker: a SIBLING file inside the (gitignored) sandbox base —
 *  deliberately NOT inside the sandbox, so it never leaks into
 *  captureWorktreeDiff (`add -A` + diff) or the child's own reads. Two
 *  parallel merges would otherwise add/add-conflict on it (found by the
 *  concurrent-merge race test). */
export const OWNER_SUFFIX = ".owner.json";

async function writeOwnerMarker(base: string, id: string): Promise<void> {
  const owner: WorktreeOwner = { pid: process.pid, id, createdAt: Date.now() };
  await fs.writeFile(path.join(base, `${id}${OWNER_SUFFIX}`), JSON.stringify(owner), { encoding: "utf8", mode: 0o600 });
}

async function readOwnerMarker(base: string, entry: string): Promise<WorktreeOwner | undefined> {
  try {
    const raw = await fs.readFile(path.join(base, `${entry}${OWNER_SUFFIX}`), "utf8");
    const parsed = JSON.parse(raw) as WorktreeOwner;
    if (typeof parsed?.pid !== "number" || typeof parsed?.id !== "string") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** Is a pid alive? EPERM counts as alive (another user's process). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

export interface SweepResult {
  removed: string[];
  kept: number;
}

/** Remove crashed runs' worktree sandboxes under <repoRoot>/.pi-worktrees.
 *  Source of truth is the DIRECTORY (covers both backends); the git
 *  registration check only decides HOW a stale dir is removed. Never removes
 *  a sandbox whose marker pid is alive. Best-effort throughout. */
export async function sweepStaleWorktrees(
  cwd: string,
  exec?: (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => Promise<{ code: number; stdout: string; stderr: string }>,
): Promise<SweepResult> {
  const removed: string[] = [];
  try {
    const root = await runGit(cwd, ["rev-parse", "--show-toplevel"], exec);
    if (!root.ok) return { removed, kept: 0 };
    const repoRoot = root.stdout.trim();
    const base = path.join(repoRoot, WORKTREE_DIR_NAME);
    let entries: string[];
    try {
      entries = await fs.readdir(base);
    } catch {
      return { removed, kept: 0 }; // no .pi-worktrees — the common path
    }
    let kept = 0;
    await withRepoLock(repoRoot, async () => {
      const list = await runGit(repoRoot, ["worktree", "list", "--porcelain"], exec);
      const registered = new Set(
        (list.ok ? list.stdout : "").split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice("worktree ".length).trim()),
      );
      for (const entry of entries) {
        if (entry.endsWith(OWNER_SUFFIX)) continue; // marker files, not sandboxes
        const dir = path.join(base, entry);
        // The nested .gitignore is a FILE, not a sandbox — never scan/rm it.
        if (!(await fs.stat(dir).then((s) => s.isDirectory()).catch(() => false))) continue;
        const owner = await readOwnerMarker(base, entry);
        if (owner && pidAlive(owner.pid)) { kept++; continue; }
        // ponytail: pid recycling can false-KEEP a stale sandbox (safe
        // direction); `/subagent worktrees clean` is the manual override.
        try {
          if (registered.has(dir)) await runGit(repoRoot, ["worktree", "remove", "--force", dir], exec);
          await fs.rm(dir, { recursive: true, force: true });
          await fs.rm(path.join(base, `${entry}${OWNER_SUFFIX}`), { force: true });
          removed.push(dir);
        } catch { /* best effort per dir */ }
      }
    });
    return { removed, kept };
  } catch {
    return { removed, kept: 0 };
  }
}

/** Ponytail ceiling: baseline patches are buffered as JS strings — refuse a
 *  pathological tree instead of blowing the heap (OMP #8939 lesson). Not a
 *  setting. */
const BASELINE_MAX_BYTES = 256 * 1024 * 1024;

/** Capture the parent's uncommitted state as PURE READS — no `git add`, no
 *  `stash create` (both mutate the parent; add stages the user's files, stash
 *  writes ODB objects). Order mirrors working-tree construction: staged, then
 *  unstaged (they can overlap), then untracked as new-file diffs. */
export async function captureParentBaseline(
  repoRoot: string,
  exec?: (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => Promise<{ code: number; stdout: string; stderr: string }>,
): Promise<{ ok: boolean; patch?: string; error?: string }> {
  try {
    const staged = await runGit(repoRoot, ["diff", "--cached", "--binary"], exec);
    if (!staged.ok) return { ok: false, error: staged.stderr.trim() || "git diff --cached failed" };
    const unstaged = await runGit(repoRoot, ["diff", "--binary"], exec);
    if (!unstaged.ok) return { ok: false, error: unstaged.stderr.trim() || "git diff failed" };
    const ls = await runGit(repoRoot, ["ls-files", "--others", "--exclude-standard"], exec);
    if (!ls.ok) return { ok: false, error: ls.stderr.trim() || "git ls-files failed" };
    const parts: string[] = [];
    let total = Buffer.byteLength(staged.stdout) + Buffer.byteLength(unstaged.stdout);
    if (total > BASELINE_MAX_BYTES) return { ok: false, error: "baseline exceeds 256 MiB budget; skipping carry" };
    if (staged.stdout.trim()) parts.push(staged.stdout);
    if (unstaged.stdout.trim()) parts.push(unstaged.stdout);
    const untracked = ls.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    for (const entry of untracked) {
      // `diff --no-index` exits 1 when files differ — here that IS success;
      // empty stdout means a vanished entry.
      const diff = await runGit(repoRoot, ["diff", "--no-index", "--binary", "--", "/dev/null", entry], exec);
      if (!diff.stdout.trim()) continue;
      total += Buffer.byteLength(diff.stdout);
      if (total > BASELINE_MAX_BYTES) return { ok: false, error: "baseline exceeds 256 MiB budget; skipping carry" };
      parts.push(diff.stdout);
    }
    return { ok: true, patch: parts.join("\n") };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Apply a captured baseline patch inside the worktree (its own index —
 *  disposable). Failure is the CALLER's cue to skip carry and note stderr. */
export async function applyBaselineToWorktree(
  worktreeDir: string,
  patch: string,
  exec?: (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => Promise<{ code: number; stdout: string; stderr: string }>,
): Promise<{ ok: boolean; error?: string }> {
  const tmp = path.join(os.tmpdir(), `pi-subagent-baseline-${randomUUID()}.patch`);
  try {
    const patchText = patch.endsWith("\n") ? patch : `${patch}\n`;
    // wx: never follow a pre-planted symlink at this path (shared /tmp).
    await fs.writeFile(tmp, patchText, { encoding: "utf8", flag: "wx" });
    const res = await runGit(worktreeDir, ["apply", "--binary", "--whitespace=nowarn", tmp], exec);
    return res.ok ? { ok: true } : { ok: false, error: (res.stderr || res.stdout).trim() || "git apply failed" };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => { /* best effort */ });
  }
}

/** Where CoW cloning is attempted: darwin `cp -c` is clonefile(2) — near-zero
 *  time and marginal disk, and the copy carries uncommitted state, node_modules
 *  and .env for free. Linux cp --reflink=auto silently degrades to a FULL copy
 *  of a big tree, so it is deliberately NOT used (git worktree is safer there). */
function cowAvailable(): boolean {
  return process.platform === "darwin";
}

/** Materialize the sandbox by CoW-cloning the working tree. The copy is a
 *  FULLY independent repo (copied .git — no shared ref namespace, no detach
 *  needed) and needs no baseline patches: it IS the working tree incl. WIP.
 *
 *  Construction is self-copy-safe (BSD cp lacks GNU's guard): each top-level
 *  entry is copied individually into a staging dir OUTSIDE the copied tree
 *  (sibling of repoRoot — same FS, so the final rename is atomic), and
 *  `.pi-worktrees` is skipped so prior sandboxes never compound into the
 *  copy. Any failure → rm staging, caller falls back to `git worktree add`. */
async function createCowClone(
  repoRoot: string,
  wtPath: string,
  exec?: (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => Promise<{ code: number; stdout: string; stderr: string }>,
): Promise<boolean> {
  if (!cowAvailable()) return false;
  const run = exec ?? defaultExec;
  const staging = path.join(path.dirname(repoRoot), `.pi-wt-tmp-${path.basename(wtPath)}`);
  try {
    await fs.mkdir(staging, { recursive: true });
    const entries = await fs.readdir(repoRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === WORKTREE_DIR_NAME) continue;
      const res = await run("cp", ["-cR", path.join(repoRoot, entry.name), path.join(staging, entry.name)], { timeout: 300_000 });
      if (res.code !== 0) return false;
    }
    await fs.mkdir(path.dirname(wtPath), { recursive: true });
    try {
      await fs.rename(staging, wtPath);
    } catch {
      // EXDEV (repoRoot is a mount point) — CoW unusable here.
      return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => { /* best effort */ });
  }
}

/** Copy gitignored files named in <repoRoot>/.worktreeinclude into the
 *  worktree (git-worktree fallback lacks them). Lines: gitignore-style globs,
 *  matched against gitignored files only (ls-files --others --ignored);
 *  `#` comments and blanks skipped. Zero-dep glob→regex, ~15 lines. */
export async function copyWorktreeIncludes(
  repoRoot: string,
  worktreeDir: string,
  exec?: (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => Promise<{ code: number; stdout: string; stderr: string }>,
): Promise<number> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(repoRoot, ".worktreeinclude"), "utf8");
  } catch {
    return 0;
  }
  const patterns = raw.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  if (patterns.length === 0) return 0;
  const regexes = patterns.map((p) => globToRegExp(p)).filter((r): r is RegExp => r !== null);
  if (regexes.length === 0) return 0;
  const ls = await runGit(repoRoot, ["ls-files", "--others", "--ignored", "--exclude-standard"], exec);
  if (!ls.ok) return 0;
  const matches = ls.stdout.split("\n").map((l) => l.trim()).filter(Boolean)
    .filter((f) => regexes.some((re) => re.test(f)));
  let copied = 0;
  for (const rel of matches.slice(0, 500)) {
    const src = path.join(repoRoot, rel);
    const dst = path.join(worktreeDir, rel);
    try {
      const st = await fs.stat(src);
      if (!st.isFile()) continue;
      await fs.mkdir(path.dirname(dst), { recursive: true });
      await fs.copyFile(src, dst);
      copied++;
    } catch { /* skip vanished/unreadable */ }
  }
  return copied;
}

/** Gitignore-style glob → RegExp. Supports `*`, `**`, `?`, leading/trailing
 *  `/`, and `dir/` (prefix). Negations unsupported (returns null). */
function globToRegExp(globRaw: string): RegExp | null {
  let glob = globRaw;
  if (glob.startsWith("!")) return null;
  let prefix = false;
  if (glob.endsWith("/")) { prefix = true; glob = glob.slice(0, -1); }
  glob = glob.replace(/^\//, "");
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") { re += ".*"; i++; }
    else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  try {
    return prefix ? new RegExp(`^${re}(/|$)`) : new RegExp(`^${re}$`);
  } catch {
    return null;
  }
}

/** Create a sandbox at .pi-worktrees/<rand> under the repo root: CoW clone of
 *  the working tree when available (carries WIP + node_modules + .env), else a
 *  detached git worktree the caller can seed with captureParentBaseline. */
export async function createWorktree(
  cwd: string,
  exec?: (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => Promise<{ code: number; stdout: string; stderr: string }>,
): Promise<{ ok: boolean; path?: string; repoRoot?: string; error?: string; /** false when the git-worktree fallback ran (caller seeds baseline); undefined = CoW copy */ cow?: boolean }> {
  try {
    const root = await runGit(cwd, ["rev-parse", "--show-toplevel"], exec);
    if (!root.ok) return { ok: false, error: root.stderr.trim() || "not a git repo" };
    const repoRoot = root.stdout.trim();
    if (!repoRoot) return { ok: false, error: "empty git root" };
    const id = `pi-subagent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const wtPath = path.join(repoRoot, WORKTREE_DIR_NAME, id);
    await ensureWorktreeBaseGitignore(path.join(repoRoot, WORKTREE_DIR_NAME));
    if (await createCowClone(repoRoot, wtPath, exec)) {
      await writeOwnerMarker(path.join(repoRoot, WORKTREE_DIR_NAME), id).catch(() => { /* best effort */ });
      return { ok: true, path: wtPath, repoRoot };
    }
    // Fallback: detached git worktree (clean HEAD; the caller seeds the
    // parent's WIP via applyBaselineToWorktree). worktree add mutates the
    // parent's shared .git/worktrees registry.
    const add = await withRepoLock(repoRoot, () => runGit(repoRoot, ["worktree", "add", "--detach", wtPath, "HEAD"], exec));
    if (!add.ok) return { ok: false, error: add.stderr.trim() || "git worktree add failed" };
    await writeOwnerMarker(path.join(repoRoot, WORKTREE_DIR_NAME), id).catch(() => { /* best effort */ });
    return { ok: true, path: wtPath, repoRoot, cow: false };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Unified diff of ALL changes in the worktree vs HEAD (tracked edits, staged
 *  changes, AND new untracked files). Stages first so untracked files are
 *  captured — the worktree is removed right after, so mutating its index is
 *  safe. A single `diff --cached HEAD` avoids duplicate hunks from combining
 *  `diff HEAD` + `diff --cached`. */
export async function captureWorktreeDiff(
  repoRoot: string,
  worktreeDir: string,
  exec?: (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => Promise<{ code: number; stdout: string; stderr: string }>,
): Promise<{ ok: boolean; diff?: string; error?: string }> {
  const add = await runGit(worktreeDir, ["add", "-A"], exec);
  if (!add.ok) return { ok: false, error: add.stderr.trim() || "git add -A failed" };
  const diff = await runGit(worktreeDir, ["diff", "--cached", "HEAD"], exec);
  if (!diff.ok) return { ok: false, error: diff.stderr.trim() || "git diff --cached HEAD failed" };
  const text = diff.stdout.trim();
  return { ok: true, diff: text || "(no changes)" };
}

/** Remove a worktree and its metadata, best-effort. Handles BOTH backends:
 *  registered git worktrees (worktree remove) and unregistered sandbox dirs
 *  (plain rm). */
export async function removeWorktree(
  repoRoot: string,
  worktreeDir: string,
  exec?: (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => Promise<{ code: number; stdout: string; stderr: string }>,
): Promise<void> {
  try {
    // Marker is a SIBLING file (never inside the sandbox — see OWNER_SUFFIX).
    await fs.rm(`${worktreeDir}${OWNER_SUFFIX}`, { force: true }).catch(() => {});
    await withRepoLock(repoRoot, async () => {
      const removed = await runGit(repoRoot, ["worktree", "remove", "--force", worktreeDir], exec);
      if (!removed.ok) await fs.rm(worktreeDir, { recursive: true, force: true }).catch(() => { /* best effort */ });
    });
  } catch { /* best effort */ }
}

/** Serialized `git apply` on the parent checkout: parallel siblings finishing
 *  at the same time must not race the merge (withRepoLock — the OMP
 *  withRepoLock equivalent, now shared with worktree add/remove too). */

/** Apply a unified diff to the repo root via `git apply --3way`. Never throws;
 *  ok:false means conflict/failure — the caller reports it and still delivers
 *  the patch text for manual merging. */
export async function applyWorktreePatch3way(
  repoRoot: string,
  diff: string,
  exec?: (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => Promise<{ code: number; stdout: string; stderr: string }>,
): Promise<{ ok: boolean; stderr: string }> {
  return withRepoLock(repoRoot, async (): Promise<{ ok: boolean; stderr: string }> => {
    const tmp = path.join(os.tmpdir(), `pi-subagent-apply-${randomUUID()}.patch`);
    try {
      // git apply interprets paths relative to cwd — write the diff to a file
      // and apply at the repo root. captureWorktreeDiff trims trailing
      // whitespace; git rejects a patch whose last line has no newline, so
      // restore it (CRLF-aware: trimming "...\r\n" must not downgrade the
      // final line ending to LF).
      const patchText = diff.endsWith("\n") ? diff : `${diff}${diff.includes("\r\n") ? "\r\n" : "\n"}`;
      // wx: never follow a pre-planted symlink at this path (shared /tmp).
      await fs.writeFile(tmp, patchText, { encoding: "utf8", flag: "wx" });
      const res = await runGit(repoRoot, ["apply", "--3way", tmp], exec);
      return { ok: res.ok, stderr: (res.stderr || res.stdout).trim() };
    } catch (error) {
      return { ok: false, stderr: error instanceof Error ? error.message : String(error) };
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => { /* best effort */ });
    }
  });
}

/** Model-facing patch block for a worktree result; "" when there is no patch.
 *  Applied merges omit the diff (the parent checkout already has it);
 *  conflicts include it plus the git apply error. */
export function formatPatchBlock(result: SubAgentResult): string {
  if (!result.patch || result.patch === "(no changes)") return "";
  const lines = result.patch.split("\n").length;
  if (result.mergeStatus === "applied") {
    return `🌿 worktree patch (${lines} diff lines) — already applied to the parent checkout via 3-way merge.`;
  }
  const head = result.mergeStatus === "conflict"
    ? `🌿 worktree patch (${lines} diff lines) — 3-way merge CONFLICTED; resolve the markers in the files, or merge manually:`
    : `🌿 worktree patch (${lines} diff lines) — merge explicitly via apply_patch or \`git apply\` (or pass merge:"3way" next time):`;
  const err = result.mergeError ? `\n\ngit apply: ${result.mergeError}` : "";
  return `${head}${err}\n\n${truncateParallelOutput(result.patch)}`;
}


export function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const texts: string[] = [];
    for (const part of msg.content) {
      if (part.type === "text" && part.text.trim()) texts.push(part.text);
    }
    if (texts.length === 0) continue;
    // Join with a newline so interleaved text segments (text around toolCall
    // parts in one message) stay separated instead of gluing "…done.Next step…".
    return texts.join("\n");
  }
  return "";
}

export function isFailedResult(result: SubAgentResult): boolean {
  // Use canonical status if available.
  if (result.status) {
    return result.status === "error" || result.status === "aborted" || result.status === "timeout";
  }
  // Fall back to legacy heuristics.
  return (
    result.exitCode !== 0 ||
    result.stopReason === "error" ||
    result.stopReason === "aborted" ||
    result.stopReason === "timeout"
  );
}

export function getResultOutput(result: SubAgentResult): string {
  if (isFailedResult(result)) {
    return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
  }
  return getFinalOutput(result.messages) || "(no output)";
}

/** Concurrency-limited map. Runs up to `concurrency` async operations at a time. */
export async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;
  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}
