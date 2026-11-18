/**
 * Rex delegation backend for the subagent module.
 *
 * Rex (https://rex.superlogical.com, the `rex` CLI + server) is a terminal
 * multiplexer. Pi running inside a Rex-managed terminal has REX_SESSION /
 * REX_BLOCK and a `rex` binary that talks to the local server, so subagent
 * tasks can be delegated to visible interactive pi panes — the herdr-TUI and
 * herdr-app backends' sibling.
 *
 * Topology mirrors the other two so the model's mental model carries over:
 *
 *   - One WINDOW (Rex's tab) per agent type, labelled with the agent name,
 *     adopted when it already exists.
 *   - One PANE (Rex's block) per agent instance: `rex split` beside the
 *     window's last tiled block.
 *   - Child = full `pi` started by the block's command, persona as a file
 *     (`--append-system-prompt`), plus `--model` / `--thinking` / `--tools`.
 *   - Results come back via the same report-file contract (pi renders on the
 *     alternate screen; read-only children reply inline).
 *
 * Divergences from the herdr backends, all forced by Rex's API surface (each
 * one live-probed against rex 0.1.0-preview.20, API revision 16):
 *
 *   - `rex block call` takes SHORT method names (`format`, not
 *     `com.superlogical.terminal.format`).
 *   - There is no `--wait` that follows a program's TURN: `rex wait` waits for
 *     a block to EXIT. Prompting therefore polls `program_status` (OSC 7501,
 *     which pi publishes) — see promptRexAndWait.
 *   - No turn counter exists, so "the paste became work" is proven by a FRESH
 *     `updated_at` on the root status record (probe-verified: a paste that is
 *     never submitted leaves the timestamp untouched; a submitted turn moves
 *     idle→working→done and stamps each transition).
 *   - Env vars ARE reachable by wrapping the child in `/usr/bin/env VAR=…`
 *     (unlike herdr-app), so rex children get the advisor marker AND the
 *     delegation recursion guard.
 *
 * All CLI calls go through an injectable `exec` (`rexCli`, the `herdrCli` /
 * `herdrAppCli` precedent) so tests script the CLI.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  allocateName,
  awaitAdvisorCycle,
  buildHerdrResult,
  buildPiArgs,
  capPaneCapture,
  dispatchStamp,
  HERDR_OFF_ENV,
  HERDR_TASK_BUDGET,
  readReportFile,
  type HerdrAgentState,
  type HerdrExec,
  type PromptOutcome,
} from "./herdr.ts";
import { defaultExec, type SubAgentResult } from "./runner.ts";
import { ADVISOR_MARKER_ENV } from "../../../lib/advisor-marker.js";

/** The exec used by the rex backend and control tool. Tests swap this. */
export const rexCli: { exec: HerdrExec } = { exec: defaultExec };

const REX_BIN = "rex";
/** Timing knobs (test seam: shorten so the failure paths run fast, the
 *  herdrHeartbeat precedent). Defaults are the shipped values:
 *  - readyTimeoutMs: readiness budget for a fresh child (cold model load +
 *    extension startup). Rex has no readiness signal, so this is the ceiling.
 *  - pollMs: status poll cadence while waiting for a turn to settle.
 *  - unsentGraceMs: how long an unchanged status may sit after the paste
 *    before we declare the submit never landed (live-probed: pi's OSC 7501
 *    timestamp does not move for a composer paste that was never submitted). */
export const rexTiming = { readyTimeoutMs: 120_000, pollMs: 700, unsentGraceMs: 8_000 };
/** Tail window pulled from a pane's scrollback for best-effort collection. */
const PANE_TAIL_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------
// Detection & kill-switch
// ---------------------------------------------------------------------------

/** Rex stamps every managed terminal with REX_SESSION; REX_BLOCK alone is not
 *  enough (a hand-made `rex` shell has no session unless one is selected). */
export function rexEnvDetected(): boolean {
  return Boolean(process.env.REX_SESSION);
}

/** Same switch as the herdr backends: `subagent.herdr:"off"` and the child
 *  recursion guard (`PI_SUBAGENT_HERDR=off`, set on every child we spawn)
 *  disable rex delegation. One knob for "visible-pane delegation". */
export function rexDisabled(subagentSettings?: { herdr?: unknown }): boolean {
  if (subagentSettings?.herdr === "off") return true;
  return process.env[HERDR_OFF_ENV] === "off";
}

let binaryProbe: Promise<boolean> | undefined;

/** `rex version` answers (Rex has no --version flag). Successes are cached for
 *  the process; failures are not (a transient failure must not disable
 *  delegation for the whole session — herdr precedent). */
export async function probeRexBinary(exec: HerdrExec = rexCli.exec): Promise<boolean> {
  const cacheable = exec === defaultExec;
  if (cacheable && binaryProbe) return binaryProbe;
  const res = await exec(REX_BIN, ["version"], { timeout: 5_000 });
  const ok = res.code === 0;
  if (cacheable && ok) binaryProbe = Promise.resolve(true);
  return ok;
}

/** Test hook: forget the cached probe result. */
export function resetRexProbe(): void {
  binaryProbe = undefined;
}

// ---------------------------------------------------------------------------
// Registry — session-scoped, one entry per dispatched pane
// ---------------------------------------------------------------------------

export interface RexHandle {
  /** Unique allocated name ("scout-1"); also the pane label and pi --name. */
  name: string;
  agentType: string;
  /** Rex WINDOW id (the tab). */
  tabId: string;
  /** Rex BLOCK id — the identity every rex command takes. */
  address: string;
  /** Block id again (buildHerdrResult/pane-ref parity with the other backends). */
  paneId: string;
  resultFile: string;
  advisorMarker: string;
  task: string;
  readOnly?: boolean;
  model: string;
  thinking?: string;
  timeoutMs: number;
  /** False when the window pre-existed (label match) — adopted windows are
   *  never eligible for close-window. */
  tabCreatedHere: boolean;
}

/** Keyed by the unique agent name; also resolvable by block id. */
const registry = new Map<string, RexHandle>();

export function getRexRegistry(): RexHandle[] {
  return [...registry.values()];
}

/** Look up a handle by allocated name OR Rex block id. */
export function findRexAgent(nameOrBlock: string): RexHandle | undefined {
  const direct = registry.get(nameOrBlock);
  if (direct) return direct;
  for (const entry of registry.values()) {
    if (entry.address === nameOrBlock || entry.paneId === nameOrBlock) return entry;
  }
  return undefined;
}

export function forgetRexWindow(windowId: string): void {
  for (const [key, entry] of registry) {
    if (key === windowId || entry.tabId === windowId) registry.delete(key);
  }
}

export function forgetRexAgent(name: string): void {
  registry.delete(name);
}

/** Test hook: reset the session registry. */
export function clearRexRegistry(): void {
  registry.clear();
}

// ---------------------------------------------------------------------------
// CLI plumbing
// ---------------------------------------------------------------------------

function firstLine(res: { stdout: string; stderr: string }): string {
  return (res.stderr || res.stdout).trim().split("\n")[0]?.slice(0, 300) ?? "";
}

/** Run a rex command and parse its JSON reply (redirected output is one line).
 *  Every call is session-scoped so a block/window id can never cross into
 *  another session. */
async function rexJson(
  exec: HerdrExec,
  args: string[],
  timeoutMs = 20_000,
): Promise<{ ok: true; data: any } | { ok: false; error: string }> {
  const session = process.env.REX_SESSION;
  const full = session ? ["-s", session, ...args] : args;
  const res = await exec(REX_BIN, full, { timeout: timeoutMs });
  if (res.code !== 0) return { ok: false, error: firstLine(res) ?? `exit ${res.code}` };
  const text = res.stdout.trim();
  if (!text) return { ok: true, data: {} };
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return { ok: false, error: `rex ${args[0]}: unparseable JSON output` };
  }
}

/** `rex block call -b <block> <method> [json]` → parsed reply. Rex takes the
 *  method's SHORT name here (the fully-qualified name is rejected). */
async function blockCall(
  exec: HerdrExec,
  address: string,
  method: string,
  args?: Record<string, unknown>,
  timeoutMs = 15_000,
): Promise<{ ok: true; data: any } | { ok: false; error: string }> {
  const argv = ["block", "call", "-b", address, method];
  if (args) argv.push(JSON.stringify(args));
  return rexJson(exec, argv, timeoutMs);
}

// ---------------------------------------------------------------------------
// Layout: windows (tabs) and blocks (panes)
// ---------------------------------------------------------------------------

export interface RexWindow {
  windowId: string;
  label: string;
}

export interface RexBlockInfo {
  blockId: string;
  label: string;
  windowId: string;
}

/** `rex window ls --json` → the session's windows (empty on failure). */
export async function listRexWindows(exec: HerdrExec): Promise<RexWindow[]> {
  const listed = await rexJson(exec, ["window", "ls", "--json"], 20_000);
  if (!listed.ok) return [];
  return (listed.data?.windows ?? [])
    .map((w: any) => ({ windowId: w?.window_id, label: w?.label ?? "" }))
    .filter((w: RexWindow) => typeof w.windowId === "string" && w.windowId.length > 0);
}

/** `rex block ls --json` → the session's blocks (empty on failure). */
export async function listRexBlocks(exec: HerdrExec): Promise<RexBlockInfo[]> {
  const listed = await rexJson(exec, ["block", "ls", "--json"], 20_000);
  if (!listed.ok) return [];
  return (listed.data?.blocks ?? [])
    .map((b: any) => ({ blockId: b?.block_id, label: b?.label ?? "", windowId: b?.window_id ?? "" }))
    .filter((b: RexBlockInfo) => typeof b.blockId === "string" && b.blockId.length > 0);
}

/** In-order leaf walk of a layout node (`block_id` leaves, `split.before/after`). */
function layoutBlocks(node: any, out: string[] = []): string[] {
  if (!node || typeof node !== "object") return out;
  if (typeof node.block_id === "string") out.push(node.block_id);
  const split = node.split;
  if (split && typeof split === "object") {
    layoutBlocks(split.before, out);
    layoutBlocks(split.after, out);
  }
  return out;
}

/**
 * The block a new split should anchor on: the window's LAST tiled block in
 * layout order (so repeated dispatches fan out instead of crowding the first
 * pane). Falls back to the window's focused block when the layout is missing,
 * and to undefined when the window holds nothing we can prove belongs to it —
 * anchoring on a foreign block would split somebody else's work.
 */
export function lastTiledBlock(window: any): string | undefined {
  for (const layer of window?.layers ?? []) {
    const blocks = layoutBlocks(layer?.layout);
    if (blocks.length > 0) return blocks[blocks.length - 1];
  }
  return typeof window?.focused_block_id === "string" ? window.focused_block_id : undefined;
}

/** Resolve one window's layout + anchor from `rex session inspect`. */
async function inspectWindow(
  exec: HerdrExec,
  windowId: string,
): Promise<{ anchor: string; blocks: string[] } | undefined> {
  const session = process.env.REX_SESSION;
  if (!session) return undefined;
  // `session inspect` takes the session POSITIONALLY and rejects the global
  // `-s` prefix (`unknown shorthand flag: 's'`) — so this one call bypasses
  // rexJson's session scoping. Every OTHER command takes -s.
  const res = await exec(REX_BIN, ["session", "inspect", session, "--json"], { timeout: 20_000 });
  if (res.code !== 0) return undefined;
  let data: any;
  try {
    data = JSON.parse(res.stdout.trim());
  } catch {
    return undefined;
  }
  const window = (data?.windows ?? []).find((w: any) => w?.window_id === windowId);
  if (!window) return undefined;
  const blocks = (window.layers ?? []).flatMap((layer: any) => layoutBlocks(layer?.layout));
  const anchor = lastTiledBlock(window);
  return anchor ? { anchor, blocks } : undefined;
}

// ---------------------------------------------------------------------------
// Child argv — pi contract from the herdr backends + env wrapper
// ---------------------------------------------------------------------------

/**
 * The command a rex block runs: `/usr/bin/env VAR=… pi <flags>`.
 *
 * argv[0] is the PROGRAM (a rex block execs the command directly, like the
 * herdr-app launcher), and `env` is the one portable way to hand a Rex child
 * environment variables — Rex's split/window-new take no --env. That buys the
 * rex backend two things the herdr-app path cannot do: the advisor review
 * marker (so the parent waits for the child's own advisor before collecting)
 * and the recursion guard (`PI_SUBAGENT_HERDR=off`, which also disables rex
 * delegation in the child).
 */
export function buildRexCommand(opts: { piArgs: string[]; advisorMarker: string }): string[] {
  return [
    "/usr/bin/env",
    `${HERDR_OFF_ENV}=off`,
    "CEULEN_THINK_GATE_OFF=1",
    `${ADVISOR_MARKER_ENV}=${opts.advisorMarker}`,
    "pi",
    ...opts.piArgs,
  ];
}

// ---------------------------------------------------------------------------
// Terminal state
// ---------------------------------------------------------------------------

export interface RexTerminal {
  address: string;
  status: HerdrAgentState;
  app: string | null;
  state: "live" | "finished" | "unknown";
  cwd?: string;
  /** Root status record's clock (ms) — the turn proof. */
  statusAt?: number;
}

function mapStatus(raw: unknown): HerdrAgentState {
  return raw === "idle" || raw === "done" || raw === "blocked" || raw === "working" ? raw : "unknown";
}

/** Root record only: child records report their own sub-statuses and must
 *  never be read as the program's lifecycle (herdr-app's `hc get` parity). */
export async function getRexTerminal(address: string, exec: HerdrExec): Promise<RexTerminal | undefined> {
  const [status, proc] = await Promise.all([
    blockCall(exec, address, "program_status", undefined, 10_000),
    blockCall(exec, address, "process", undefined, 10_000),
  ]);
  if (!status.ok && !proc.ok) return undefined;
  const records: any[] = status.ok ? (status.data?.records ?? []) : [];
  const root = records.find((r: any) => r?.id === undefined) ?? records[0];
  const statusAt = root?.updated_at ? Date.parse(String(root.updated_at)) : undefined;
  const lastExit = proc.ok ? proc.data?.last_exit : undefined;
  return {
    address,
    status: mapStatus(root?.state),
    app: typeof root?.app === "string" ? root.app : null,
    // A reported `last_exit` means the block's program ended.
    state: proc.ok ? (lastExit ? "finished" : "live") : "unknown",
    cwd: proc.ok ? proc.data?.foreground?.cwd : undefined,
    statusAt: Number.isFinite(statusAt) ? statusAt : undefined,
  };
}

/** Settled = idle/done, and not a finished program. Unknown fails closed. */
function isSettled(t: RexTerminal | undefined): boolean {
  if (!t) return false;
  return t.state === "live" && (t.status === "idle" || t.status === "done");
}

// ---------------------------------------------------------------------------
// Prepare: validate + topology + spawn (no prompt)
// ---------------------------------------------------------------------------

export interface PrepareRexTaskOptions {
  agentType: string;
  systemPrompt: string;
  task: string;
  cwd: string;
  model?: string;
  thinking?: string;
  tools?: string[];
  readOnly?: boolean;
  timeoutMs: number;
}

function resultFilePath(cwd: string, name: string, stamp: string): string {
  return path.join(cwd, ".pi", "rex", `${name}-${stamp}.md`);
}

function advisorMarkerPath(cwd: string, stamp: string): string {
  return path.join(cwd, ".pi", "rex", `${stamp}.advisor.json`);
}

/** Create the agent type's window, or adopt the one already labelled for it. */
async function ensureRexWindow(opts: {
  exec: HerdrExec;
  agentType: string;
  cwd: string;
  command: string[];
}): Promise<{ windowId: string; blockId: string; created: boolean }> {
  const existing = (await listRexWindows(opts.exec)).find((w) => w.label === opts.agentType);
  if (existing) {
    const inspected = await inspectWindow(opts.exec, existing.windowId);
    // Adopt with a known anchor when we can prove the layout; otherwise the
    // caller falls back to a plain split beside the focused block.
    return { windowId: existing.windowId, blockId: inspected?.anchor ?? "", created: false };
  }
  // The window label is a POSITIONAL argument (not a flag); `--` separates it
  // from the command so a label can never be read as one.
  const created = await rexJson(
    opts.exec,
    ["window", "new", opts.agentType, "-c", opts.cwd, "--focus=false", "--json", "--", ...opts.command],
    60_000,
  );
  if (!created.ok) throw new Error(`rex window new failed: ${created.error}`);
  const windowId = created.data?.window_id;
  const blockId = created.data?.block_ids?.[0];
  if (typeof windowId !== "string" || typeof blockId !== "string") {
    throw new Error("rex window new: unexpected response shape (missing window_id/block_ids)");
  }
  return { windowId, blockId, created: true };
}

/** Split a new pane into an existing window beside `anchor`. */
async function splitRexPane(opts: {
  exec: HerdrExec;
  anchor: string;
  label: string;
  cwd: string;
  command: string[];
  direction: "right" | "below";
}): Promise<string> {
  const split = await rexJson(
    opts.exec,
    [
      "split", "-b", opts.anchor,
      "--split", opts.direction,
      "--label", opts.label,
      "-c", opts.cwd,
      "--focus=false",
      "--json",
      "--", ...opts.command,
    ],
    60_000,
  );
  if (!split.ok) throw new Error(`rex split failed: ${split.error}`);
  const blockId = split.data?.block_ids?.[0];
  if (typeof blockId !== "string") throw new Error("rex split: unexpected response shape (missing block_ids)");
  return blockId;
}

// ponytail: per-agent-type serialization (herdr prepareChains precedent) —
// two concurrent same-type dispatches would race window adoption and pane
// anchoring. The expensive part (prompt + run) stays parallel.
const prepareChains = new Map<string, Promise<RexHandle>>();

async function prepareRexTaskUncached(opts: PrepareRexTaskOptions): Promise<RexHandle> {
  const exec = rexCli.exec;
  if (Buffer.byteLength(opts.task, "utf8") > HERDR_TASK_BUDGET) {
    throw new Error(`rex task exceeds the ${HERDR_TASK_BUDGET}-byte budget (delivery wrapper included) — shorten the task or use runner:"sdk".`);
  }
  const live = await listRexBlocks(exec);
  const name = allocateName(opts.agentType, [
    ...live.map((b) => b.label),
    ...live.map((b) => b.blockId),
    ...registry.keys(),
  ]);
  const stamp = dispatchStamp();
  const handle: RexHandle = {
    name,
    agentType: opts.agentType,
    tabId: "",
    address: "",
    paneId: "",
    resultFile: resultFilePath(opts.cwd, name, stamp),
    advisorMarker: advisorMarkerPath(opts.cwd, stamp),
    task: opts.task,
    readOnly: opts.readOnly,
    model: opts.model ?? "",
    thinking: opts.thinking,
    timeoutMs: opts.timeoutMs,
    tabCreatedHere: true,
  };
  registry.set(name, handle);
  try {
    await fs.mkdir(path.dirname(handle.resultFile), { recursive: true });
    const systemPromptFile = path.join(path.dirname(handle.resultFile), `${name}.system.md`);
    await fs.writeFile(systemPromptFile, opts.systemPrompt, "utf8");
    // Build argv BEFORE topology: a validation failure (read-only sandbox with
    // no allowed tools) must leave no orphan window behind.
    const piArgs = buildPiArgs({
      name,
      systemPromptFile,
      model: opts.model,
      thinking: opts.thinking,
      tools: opts.tools,
      readOnly: opts.readOnly,
      sessionStamp: stamp,
    });
    const command = buildRexCommand({ piArgs, advisorMarker: handle.advisorMarker });

    const spawned = await ensureRexWindow({ exec, agentType: opts.agentType, cwd: opts.cwd, command });
    handle.tabId = spawned.windowId;
    handle.tabCreatedHere = spawned.created;
    if (spawned.created) {
      handle.address = spawned.blockId;
      handle.paneId = spawned.blockId;
    } else {
      // Adopted window: add a pane beside its last tiled block so this
      // dispatch's work is visible without disturbing existing panes.
      const anchor = spawned.blockId || (await inspectWindow(exec, spawned.windowId))?.anchor;
      if (!anchor) {
        throw new Error(`rex: window "${opts.agentType}" has no block to split beside — open a shell in it, or use runner:"sdk".`);
      }
      const direction = (await listRexBlocks(exec)).filter((b) => b.windowId === spawned.windowId).length % 2 === 1 ? "right" : "below";
      const blockId = await splitRexPane({ exec, anchor, label: name, cwd: opts.cwd, command, direction });
      handle.address = blockId;
      handle.paneId = blockId;
    }
    return handle;
  } catch (err) {
    registry.delete(handle.name);
    throw err;
  }
}

export function prepareRexTask(opts: PrepareRexTaskOptions): Promise<RexHandle> {
  const prev = prepareChains.get(opts.agentType) ?? Promise.resolve(null as unknown as RexHandle);
  const job = prev.then(
    () => prepareRexTaskUncached(opts),
    () => prepareRexTaskUncached(opts),
  );
  prepareChains.set(opts.agentType, job);
  job.catch(() => { /* stored chain must not reject unhandled */ });
  return job;
}

// ---------------------------------------------------------------------------
// Prompt + wait
// ---------------------------------------------------------------------------

/** Task + delivery contract (identical wording to the herdr backends). */
export function wrapRexTaskPrompt(task: string, resultFile: string, readOnly = false): string {
  if (readOnly) {
    return (
      `${task}\n\n---\n` +
      `Delivery: this session has read-only tools — do NOT write any files. ` +
      `Reply with your full final report as your final message.`
    );
  }
  return (
    `${task}\n\n---\n` +
    `Delivery: when your task is complete, write your full final report as Markdown to \`${resultFile}\` ` +
    `(create parent directories if needed), then reply with a one-line summary only. ` +
    `If follow-up feedback arrives after delivery (e.g. an advisor review), apply it and update the report file to the corrected version.`
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Submit the task and wait for that turn to settle.
 *
 * Rex offers no primitive that follows a program's turn (`rex wait` waits for
 * an EXIT), so this is built from `program_status` polling — the hc `--wait`
 * policy re-implemented:
 *
 *   1. Readiness gate: `send` pastes into whatever is on screen, so wait for a
 *      live `pi` reporting idle/done before pasting (a paste into a booting
 *      composer is lost while the caller sees a settled state).
 *   2. Paste + Enter as two calls (`block send` types without executing).
 *   3. Settle on done, on idle/done with a FRESH status timestamp, or on
 *      blocked. Freshness is the turn proof: a paste that never submitted
 *      leaves pi at its previous state AND timestamp (live-probed), so an
 *      unchanged timestamp after the grace window is reported as "pasted but
 *      never submitted" rather than collected as a success.
 */
export async function promptRexAndWait(opts: {
  address: string;
  text: string;
  timeoutMs: number;
  exec: HerdrExec;
  signal?: AbortSignal;
}): Promise<PromptOutcome> {
  if (opts.signal?.aborted) {
    return { state: "unknown", delivered: false, error: "aborted: parent operation aborted" };
  }
  const ready = await waitForReady(opts.address, opts.exec, opts.signal);
  if (!ready.ok) return { state: ready.state, delivered: false, error: ready.error };
  const baseline = ready.statusAt;

  const sent = await rexJson(opts.exec, ["block", "send", "-b", opts.address, opts.text], 60_000);
  if (!sent.ok) return { state: ready.state, delivered: false, error: `rex block send failed: ${sent.error}` };
  const entered = await rexJson(opts.exec, ["block", "send-key", "-b", opts.address, "enter"], 20_000);
  if (!entered.ok) return { state: ready.state, delivered: false, error: `rex block send-key failed: ${entered.error}` };

  const deadline = Date.now() + opts.timeoutMs;
  const graceUntil = Date.now() + rexTiming.unsentGraceMs;
  let sawWorking = false;
  let last: RexTerminal | undefined;
  for (;;) {
    if (opts.signal?.aborted) {
      await cancelRexAgent(opts.address, opts.exec);
      return { state: "unknown", delivered: true, error: "aborted: parent operation aborted" };
    }
    last = await getRexTerminal(opts.address, opts.exec);
    const state = last?.status ?? "unknown";
    const fresh = last?.statusAt !== undefined && (baseline === undefined || last.statusAt > baseline);
    if (state === "working" || state === "blocked") sawWorking = true;
    if (state === "blocked") {
      return { state, delivered: false, error: "Agent is blocked on a dialog — answer it in its pane, then prompt again." };
    }
    // A turn ran (fresh timestamp) and settled, or we watched it work first.
    if ((state === "done" || state === "idle") && (fresh || sawWorking)) {
      return { state, delivered: true };
    }
    if (!sawWorking && !fresh && Date.now() >= graceUntil) {
      return {
        state,
        delivered: false,
        error: "the task was pasted but never submitted (no fresh status since the paste) — the child was not ready or a dialog holds the composer; prompt it again in its pane",
      };
    }
    if (Date.now() >= deadline) {
      return { state, delivered: true, error: `timeout after ${opts.timeoutMs}ms` };
    }
    await sleep(rexTiming.pollMs);
  }
}

/** Poll until a live, input-ready pi answers. `done` counts as ready — pi
 *  reports it for a turn that finished unwatched, and that composer takes
 *  input exactly like `idle`. */
async function waitForReady(
  address: string,
  exec: HerdrExec,
  signal?: AbortSignal,
  ): Promise<{ ok: true; statusAt?: number; state: HerdrAgentState } | { ok: false; state: HerdrAgentState; error: string }> {
  const deadline = Date.now() + rexTiming.readyTimeoutMs;
  let last: RexTerminal | undefined;
  for (;;) {
    if (signal?.aborted) return { ok: false, state: "unknown", error: "aborted: parent operation aborted" };
    last = await getRexTerminal(address, exec);
    if (last?.state === "finished") {
      return { ok: false, state: "unknown", error: "the child terminal exited before its task was sent" };
    }
    if (last?.app === "pi" && (last.status === "idle" || last.status === "done")) {
      return { ok: true, statusAt: last.statusAt, state: last.status };
    }
    if (Date.now() >= deadline) {
      return {
        ok: false,
        state: last?.status ?? "unknown",
        error: `the child did not become ready for input within ${Math.round(rexTiming.readyTimeoutMs / 1000)}s${last?.status ? ` (last state: ${last.status})` : ""} — check its pane`,
      };
    }
    await sleep(rexTiming.pollMs);
  }
}

// ---------------------------------------------------------------------------
// Collection & cancel
// ---------------------------------------------------------------------------

/** Tail of a block's scrollback. `format` returns a HEAD slice (plus an id
 *  when more remains), so the end is re-read through `blob_read` at
 *  `total - N`; asking for the whole 64 MiB scrollback would park megabytes in
 *  the parent's context. */
export async function readRexBlock(
  address: string,
  exec: HerdrExec,
  maxBytes = PANE_TAIL_BYTES,
): Promise<{ ok: boolean; text: string }> {
  const head = await blockCall(exec, address, "format", { format: "text", trim: true, unwrap: true, max_bytes: 512 }, 20_000);
  if (!head.ok) return { ok: false, text: head.error };
  const content: string = head.data?.content ?? "";
  const total: number = typeof head.data?.total === "number" ? head.data.total : 0;
  const id = head.data?.id;
  // `format` answers a HEAD slice, and an `id` in the reply means more output
  // remains — so ANY reply carrying an id must be re-read from the END of the
  // scrollback. (Comparing `total` against the cap instead was the bug: a
  // 892-byte pane still came back as the boot chrome head, and the reply the
  // child actually wrote was never fetched — live 2026-11-18.)
  if (typeof id !== "number") return { ok: true, text: content };
  const tail = await blockCall(
    exec,
    address,
    "blob_read",
    { id, offset: Math.max(0, total - maxBytes), max_bytes: Math.min(maxBytes, 983_040) },
    20_000,
  );
  if (tail.ok && typeof tail.data?.data === "string") return { ok: true, text: tail.data.data };
  return { ok: true, text: content };
}

/**
 * The pane's reply, or "" when the pane holds nothing but our echoed task.
 * Strategy is the herdr-app one — the reply always comes AFTER our own text,
 * so cut rather than subtract: find the delivery contract (or the task) and
 * keep the tail. Best effort by design; a genuinely fresh turn keeps the raw
 * tail when neither marker survives TUI wrapping.
 */
export function replyBeyondEcho(paneText: string, task: string): string {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const flat = norm(paneText);
  const contractEnd = (() => {
    const re = /Delivery: [\s\S]*?(?:corrected version\.|final message\.)/g;
    let last = -1;
    for (const m of flat.matchAll(re)) last = (m.index ?? 0) + m[0].length;
    return last;
  })();
  const cut = contractEnd >= 0 ? flat.slice(contractEnd) : (() => {
    const at = task ? flat.indexOf(norm(task)) : -1;
    return at >= 0 ? flat.slice(at + norm(task).length) : flat;
  })();
  return cut
    .replace(/\u2191[\d.]+K?\s*\u2193[\d.]+[\s\S]*$/g, "")
    .replace(/[\u03c0]\s*>.*$/g, "")
    .replace(/^\s*[\u2570\u2500]+.*$/g, "")
    .trim();
}

/** Report file first (delivery contract), pane tail as best-effort fallback. */
export async function collectRexResult(opts: {
  handle: RexHandle;
  exec: HerdrExec;
}): Promise<{ output: string; source: "file" | "pane" | "none" }> {
  const fromFile = await readReportFile(opts.handle.resultFile);
  if (fromFile) return { output: fromFile, source: "file" };
  const read = await readRexBlock(opts.handle.address, opts.exec);
  if (!read.ok) return { output: "", source: "none" };
  const lines = read.text.split("\n").slice(-200).join("\n");
  const reply = replyBeyondEcho(lines, opts.handle.task);
  // An echo-only capture is NOT a reply — report no output so the caller fails
  // loudly instead of returning the task back as a successful report.
  if (!reply || norm0(reply) === norm0(opts.handle.task)) return { output: "", source: "none" };
  return { output: capPaneCapture(reply), source: "pane" };
}

const norm0 = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Interrupt a delegated agent: esc (pi's interrupt), then ctrl+c when the
 * terminal is not verifiably settled — herdr's escalation shape.
 */
export async function cancelRexAgent(address: string, exec: HerdrExec = rexCli.exec): Promise<void> {
  const esc = await rexJson(exec, ["block", "send-key", "-b", address, "esc"], 10_000);
  if (!esc.ok) return;
  await sleep(500);
  try {
    const info = await getRexTerminal(address, exec);
    if (!isSettled(info)) await rexJson(exec, ["block", "send-key", "-b", address, "ctrl+c"], 10_000);
  } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// High-level flow
// ---------------------------------------------------------------------------

export interface ExecuteRexTaskOptions {
  exec?: HerdrExec;
  onState?: (state: string) => void;
  signal?: AbortSignal;
  advisorWaitMs?: number;
  onAdvisorPhase?: (phase: string) => void;
}

/** Prompt the prepared agent, wait for settle, collect the report. */
export async function executeRexTask(
  handle: RexHandle,
  opts: ExecuteRexTaskOptions = {},
): Promise<SubAgentResult> {
  const exec = opts.exec ?? rexCli.exec;
  const startedAt = Date.now();
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let lastState = "";
  let pollInFlight = false;
  const poll = async () => {
    if (pollInFlight) return;
    pollInFlight = true;
    try {
      const state = (await getRexTerminal(handle.address, exec))?.status ?? "unknown";
      if (state !== lastState) {
        lastState = state;
        opts.onState?.(state);
      }
    } catch { /* state poll is best-effort */ }
    pollInFlight = false;
  };
  try {
    pollTimer = setInterval(() => { void poll(); }, 2_000);
    pollTimer.unref?.();
    const prompt = await promptRexAndWait({
      address: handle.address,
      text: wrapRexTaskPrompt(handle.task, handle.resultFile, handle.readOnly),
      timeoutMs: handle.timeoutMs,
      exec,
      signal: opts.signal,
    });
    let output = "";
    let outputSource: "file" | "pane" | "none" = "none";
    let advisorRounds = 0;
    const aborted = Boolean(opts.signal?.aborted);
    const timedOut = !aborted && Boolean(prompt.error && /timeout/.test(prompt.error));
    if (timedOut) {
      await cancelRexAgent(handle.address, exec);
      prompt.error = `${prompt.error} (pane interrupted; it may still complete its current write — check ${path.basename(handle.resultFile)} or the pane before re-dispatching)`;
    } else if (!aborted) {
      advisorRounds = await awaitAdvisorCycle({
        name: handle.address,
        markerFile: handle.advisorMarker,
        advisorWaitMs: opts.advisorWaitMs ?? 0,
        signal: opts.signal,
        onPhase: opts.onAdvisorPhase,
        getState: async () => (await getRexTerminal(handle.address, exec))?.status ?? "unknown",
      });
      const collected = await collectRexResult({ handle, exec });
      output = collected.output;
      outputSource = collected.source;
    }
    const result = buildHerdrResult(
      {
        name: handle.name,
        agentType: handle.agentType,
        tabId: handle.tabId,
        paneId: handle.paneId,
        resultFile: handle.resultFile,
        advisorMarker: handle.advisorMarker,
        task: handle.task,
        readOnly: handle.readOnly,
        model: handle.model,
        thinking: handle.thinking,
        timeoutMs: handle.timeoutMs,
        tabCreatedHere: handle.tabCreatedHere,
      },
      {
        state: prompt.state,
        delivered: prompt.delivered,
        error: prompt.error,
        output,
        outputSource,
        durationMs: Date.now() - startedAt,
      },
    );
    // Pane identity rides the usage line (herdr precedent) — rex: not herdr:.
    result.model = (result.model ?? "").replace(" · herdr pane:", " · rex pane:");
    if (advisorRounds > 0) result.advisorRounds = advisorRounds;
    if (aborted) {
      result.stopReason = "aborted";
      result.status = "aborted";
      result.exitCode = 1;
      result.errorMessage = "Cancelled: parent operation aborted";
    }
    return result;
  } finally {
    if (pollTimer) clearInterval(pollTimer);
  }
}

// ---------------------------------------------------------------------------
// Layout helpers for the control tool
// ---------------------------------------------------------------------------

/** Busy siblings in a window (closing it kills every pane in it). */
export async function rexWindowCloseBlockers(
  handle: RexHandle,
  exec: HerdrExec,
): Promise<{ siblings: string[]; self: string | undefined }> {
  const siblings: string[] = [];
  for (const entry of registry.values()) {
    if (entry.tabId !== handle.tabId || entry.address === handle.address) continue;
    const info = await getRexTerminal(entry.address, exec);
    // Fail closed: only an observed settled state proves the sibling is free.
    if (!isSettled(info)) siblings.push(entry.name);
  }
  const selfInfo = await getRexTerminal(handle.address, exec);
  const self = selfInfo && !isSettled(selfInfo) ? selfInfo.status ?? "unknown" : undefined;
  return { siblings, self };
}

/** Raise the agent's window in the Rex app. */
export async function focusRexWindow(windowId: string, exec: HerdrExec): Promise<{ ok: boolean; error?: string }> {
  const res = await rexJson(exec, ["focus", windowId], 15_000);
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

/** Close a window this session created (and the panes in it). */
export async function closeRexWindow(windowId: string, exec: HerdrExec): Promise<{ ok: boolean; error?: string }> {
  const res = await rexJson(exec, ["window", "close", windowId], 30_000);
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

/** Submit a follow-up prompt without waiting (control tool, wait:false). */
export async function sendRexPrompt(address: string, text: string, exec: HerdrExec): Promise<{ ok: boolean; error?: string }> {
  const send = await rexJson(exec, ["block", "send", "-b", address, text], 60_000);
  if (!send.ok) return { ok: false, error: send.error };
  const enter = await rexJson(exec, ["block", "send-key", "-b", address, "enter"], 20_000);
  return enter.ok ? { ok: true } : { ok: false, error: enter.error };
}

