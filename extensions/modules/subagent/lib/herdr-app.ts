/**
 * herdr-app delegation backend for the subagent module.
 *
 * herdr-TUI delegation (lib/herdr.ts) drives the `herdr` CLI from inside a
 * herdr managed pane (`HERDR_ENV=1`). The herdr DESKTOP app is a different
 * pair of programs: the app arranges windows (`herdr-app`), herdr-core (`hc`)
 * runs the terminals. Pi inside an app pane has `HC_TERMINAL_ID` and no
 * `HERDR_ENV`, so herdr.ts never fires.
 *
 * Topology mirrors the TUI backend so the model's mental model carries over:
 *
 *   - One TAB per agent type (created with `herdr-app do tab.new --argv
 *     '["pi", …]'`), adopted when a tab of that label already exists.
 *   - One PANE per agent instance (`pane.split`), one terminal each.
 *   - Every terminal is an `hc` terminal: `hc send --wait` submits the task and
 *     follows THAT turn (herdr-core's real OSC 7501 status — no TUI stall
 *     workaround is needed here), `hc read` collects, `hc interrupt` stops.
 *   - Results come back via the same file contract as the TUI backend (pi
 *     renders on the alternate screen; read-only children reply inline).
 *
 * All CLI calls go through an injectable `exec` (the `herdrAppCli` seam, the
 * herdr.ts `herdrCli` precedent) so tests script both binaries.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ADVISOR_MARKER_ENV } from "../../../lib/advisor-marker.js";
import {
  allocateName,
  awaitAdvisorCycle,
  buildHerdrResult,
  capPaneCapture,
  dispatchStamp,
  HERDR_OFF_ENV,
  HERDR_TASK_BUDGET,
  MAX_REPORT_BYTES,
  readReportFile,
  type HerdrAgentState,
  type HerdrExec,
  type PromptOutcome,
} from "./herdr.ts";
import { defaultExec, type SubAgentResult } from "./runner.ts";
import { buildPiArgs, type BuildPiArgsOptions } from "./herdr.ts";

/** The exec used by the app backend and control tool. Tests swap this. */
export const herdrAppCli: { exec: HerdrExec } = { exec: defaultExec };

/** Binary names, resolved on PATH (the user may symlink either). */
const APP_BIN = "herdr-app";
const HC_BIN = "hc";
/** How long a fresh app child may take to reach an input-ready idle pi.
 *  Cold model loading + extension startup are slow; the TUI backend waits
 *  inside `herdr agent start`, this is the app path's equivalent. */
const READY_TIMEOUT_MS = 120_000;

/**
 * Detection: herdr-core stamps every terminal it runs with HC_TERMINAL_ID.
 * That is strictly wider than "inside the app window" (an `hc run` terminal
 * from a plain shell has it too) — deliberately, because delegation works
 * from any herdr-core terminal, and the app is only needed for the layout
 * commands (which fail loudly if no window is open).
 */
export function herdrAppEnvDetected(): boolean {
  return Boolean(process.env.HC_TERMINAL_ID);
}

/** Same kill-switch as the TUI backend: `subagent.herdr:"off"` disables
 *  delegation everywhere, and the child recursion guard is shared. */
export function herdrAppDisabled(subagentSettings?: { herdr?: unknown }): boolean {
  if (subagentSettings?.herdr === "off") return true;
  return process.env[HERDR_OFF_ENV] === "off";
}

let appProbe: Promise<boolean> | undefined;
let hcProbe: Promise<boolean> | undefined;

/** Both binaries must answer: the app for layout, hc for the terminal. */
export async function probeHerdrAppBinary(exec: HerdrExec = defaultExec): Promise<boolean> {
  const cacheable = exec === defaultExec;
  if (cacheable && appProbe && hcProbe) return (await appProbe) && (await hcProbe);
  const app = (async () => {
    const res = await exec(APP_BIN, ["--version"], { timeout: 5_000 });
    const ok = res.code === 0;
    // Cache successes only (herdr.ts precedent): a transient failure must not
    // disable delegation for the process lifetime.
    if (cacheable && ok) appProbe = Promise.resolve(true);
    return ok;
  })();
  const hc = (async () => {
    const res = await exec(HC_BIN, ["--version"], { timeout: 5_000 });
    const ok = res.code === 0;
    if (cacheable && ok) hcProbe = Promise.resolve(true);
    return ok;
  })();
  return (await app) && (await hc);
}

// ---------------------------------------------------------------------------
// Registry — session-scoped, one entry per dispatched tab
// ---------------------------------------------------------------------------

export interface HerdrAppHandle {
  /** Tab label = agent type. Adopted tabs keep their label. */
  tabName: string;
  tabId: string;
  /** hc terminal address ("t7") — the identity every hc command takes. */
  address: string;
  /** App pane id, when the app reported one ("" when only hc knows the terminal). */
  paneId: string;
  /** Allocated name; also passed to the child as pi --name for its title. */
  name: string;
  agentType: string;
  task: string;
  resultFile: string;
  /** Advisor review-cycle sidecar (ADVISOR_MARKER_ENV), same contract as herdr.ts. */
  advisorMarker: string;
  readOnly?: boolean;
  model: string;
  thinking?: string;
  timeoutMs: number;
  /** False when the tab pre-existed (label match) — adopted tabs are never
   *  eligible for close-tab. */
  tabCreatedHere: boolean;
}

/** Keyed by the UNIQUE agent name (herdr.ts precedent) — parallel dispatches of
 *  one agent type share a tab but must each stay addressable. */
const registry = new Map<string, HerdrAppHandle>();

export function getHerdrAppRegistry(): HerdrAppHandle[] {
  return [...registry.values()];
}

/** Look up a handle by allocated name OR hc address (the control tool accepts
 *  either; `hc` does too). */
export function findHerdrAppAgent(nameOrAddress: string): HerdrAppHandle | undefined {
  const direct = registry.get(nameOrAddress);
  if (direct) return direct;
  for (const entry of registry.values()) {
    if (entry.address === nameOrAddress || entry.name === nameOrAddress) return entry;
  }
  return undefined;
}

export function isDelegatedHerdrAppAgent(nameOrAddress: string): boolean {
  return Boolean(findHerdrAppAgent(nameOrAddress));
}

export function forgetHerdrAppTab(tabNameOrId: string): void {
  for (const [key, entry] of registry) {
    if (key === tabNameOrId || entry.tabId === tabNameOrId) registry.delete(key);
  }
}

/** Test hook: reset the session registry. */
export function clearHerdrAppRegistry(): void {
  registry.clear();
}

// ---------------------------------------------------------------------------
// CLI plumbing
// ---------------------------------------------------------------------------

function firstLine(res: { stdout: string; stderr: string }): string {
  return (res.stderr || res.stdout).trim().split("\n")[0]?.slice(0, 300) ?? "";
}

/** Parse a JSON payload; both CLIs answer `{…}` (sometimes wrapped in `result`). */
function parseJson(text: string): any | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** `hc … --json` → { ok, data } (errors are JSON on stderr with `kind`). */
async function hcJson(
  exec: HerdrExec,
  args: string[],
  timeoutMs = 20_000,
): Promise<{ ok: true; data: any } | { ok: false; error: string }> {
  const res = await exec(HC_BIN, [...args, "--json"], { timeout: timeoutMs });
  const data = parseJson(res.stdout.trim() || res.stderr.trim());
  if (res.code !== 0) {
    const message = data?.error?.message ?? firstLine(res) ?? `exit ${res.code}`;
    return { ok: false, error: message };
  }
  return { ok: true, data: data ?? {} };
}

/** `herdr-app do <command> --key value…` → parsed reply (or its error). */
async function appDo(
  exec: HerdrExec,
  command: string,
  args: Record<string, unknown> = {},
  timeoutMs = 60_000,
): Promise<{ ok: true; data: any } | { ok: false; error: string }> {
  const cliArgs = ["do", command, JSON.stringify(args)];
  const res = await exec(APP_BIN, cliArgs, { timeout: timeoutMs });
  const data = parseJson(res.stdout.trim());
  if (res.code !== 0 || (data && typeof data.error === "string")) {
    return { ok: false, error: data?.error ?? firstLine(res) ?? `herdr-app ${command} failed (exit ${res.code})` };
  }
  return { ok: true, data: data ?? {} };
}

// ---------------------------------------------------------------------------
// herdr-app layout: spaces, tabs, panes
// ---------------------------------------------------------------------------

export interface AppTab {
  id: string;
  name: string;
  terminals: { terminal: string; pane: string; status?: string | null; app?: string | null }[];
}

export interface AppSpace {
  id: string;
  name: string;
  machine: string | null;
  tabs: AppTab[];
}

/** `herdr-app ls` → spaces (empty when no window answers). */
export async function listAppSpaces(exec: HerdrExec): Promise<AppSpace[]> {
  const res = await exec(APP_BIN, ["ls"], { timeout: 20_000 });
  const data = parseJson(res.stdout.trim());
  if (res.code !== 0 || !data) return [];
  return (data.spaces ?? []).map((s: any) => ({
    id: s?.id,
    name: s?.name ?? "",
    machine: s?.machine ?? null,
    tabs: (s?.tabs ?? []).map((t: any) => ({
      id: t?.id,
      name: t?.name ?? "",
      terminals: (t?.terminals ?? []).map((x: any) => ({
        terminal: x?.terminal,
        pane: x?.pane,
        status: x?.status ?? null,
        app: x?.app ?? null,
      })),
    })),
  })).filter((s: AppSpace) => Boolean(s.id));
}

/** The space holding the caller's own terminal (by its herdr.space label),
 *  else the first local space. Returns undefined when no window is open. */
async function resolveSpace(exec: HerdrExec, listed?: AppSpace[]): Promise<AppSpace | undefined> {
  const spaces = listed ?? await listAppSpaces(exec);
  if (spaces.length === 0) return undefined;
  const ownId = process.env.HC_TERMINAL_ID;
  if (ownId) {
    const got = await hcJson(exec, ["get", ownId], 10_000);
    const label = got.ok ? got.data?.labels?.["herdr.space"] : undefined;
    if (typeof label === "string") {
      const match = spaces.find((s) => s.id === label);
      if (match) return match;
    }
  }
  return spaces.find((s) => s.machine === null) ?? spaces[0];
}

/** Resolve the caller's space and any tab already labelled `agentType`. ONE
 *  `herdr-app ls` per prepare — the caller passes the list through. */
async function resolveSpaceAndTab(
  exec: HerdrExec,
  agentType: string,
): Promise<{ spaces: AppSpace[]; space?: AppSpace; tab?: AppTab }> {
  const spaces = await listAppSpaces(exec);
  const space = await resolveSpace(exec, spaces);
  const tab = space?.tabs.find((t) => t.name === agentType);
  return { spaces, space, tab };
}

/** All live hc terminal names + addresses (dedupe baseline for allocateName). */
async function liveTerminalIds(exec: HerdrExec): Promise<string[]> {
  const listed = await hcJson(exec, ["ls"], 15_000);
  if (!listed.ok) return [];
  const terminals: any[] = listed.data?.terminals ?? [];
  const ids: string[] = [];
  for (const t of terminals) {
    if (typeof t?.address === "string") ids.push(t.address);
    if (typeof t?.name === "string" && t.name) ids.push(t.name);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Child argv — TUI parity minus `--name` (hc carries the name instead)
// ---------------------------------------------------------------------------

/**
 * The pi argv for an hc/app-launched child. Same persona/model/thinking/tools
 * contract as the herdr-TUI child, with ONE herdr-app constraint: argv[0] must
 * be the PROGRAM (the app's launcher runs `argv[0]` and forwards the rest),
 * whereas buildPiArgs starts with flags for `herdr agent start --kind pi`.
 */
export function buildAppPiArgs(opts: BuildPiArgsOptions): string[] {
  return ["pi", ...buildPiArgs(opts)];
}

// ---------------------------------------------------------------------------
// Terminal state
// ---------------------------------------------------------------------------

export interface HerdrAppTerminal {
  address: string;
  status: HerdrAgentState;
  app: string | null;
  state: "live" | "finished" | "unknown";
  cwd?: string;
  title?: string;
}

/** `hc get <t>` — real OSC 7501 status (unlike herdr 0.9.x pi panes). */
export async function getTerminal(address: string, exec: HerdrExec): Promise<HerdrAppTerminal | undefined> {
  const got = await hcJson(exec, ["get", address], 10_000);
  if (!got.ok) return undefined;
  const t = got.data?.result ?? got.data;
  const raw = t?.status?.state;
  return {
    address: t?.address ?? address,
    status: raw === "idle" || raw === "done" || raw === "blocked" || raw === "working" ? raw : "unknown",
    app: t?.status?.app ?? null,
    state: t?.state === "live" || t?.state === "finished" ? t.state : "unknown",
    cwd: t?.cwd,
    title: t?.title,
  };
}

/** Settled = idle/done/finished. Blocked/unknown fail closed (never "done"). */
function isSettled(t: HerdrAppTerminal | undefined): boolean {
  if (!t) return false;
  return t.state === "finished" || t.status === "idle" || t.status === "done";
}

// ---------------------------------------------------------------------------
// Prepare: validate + topology + spawn (no prompt)
// ---------------------------------------------------------------------------

export interface PrepareHerdrAppTaskOptions {
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
  return path.join(cwd, ".pi", "herdr-app", `${name}-${stamp}.md`);
}

function advisorMarkerPath(cwd: string, stamp: string): string {
  return path.join(cwd, ".pi", "herdr-app", `${stamp}.advisor.json`);
}

/** Spawn the child in a NEW tab (the common path: one tab per agent type). */
async function spawnInNewTab(opts: {
  exec: HerdrExec;
  agentType: string;
  spaceId: string;
  cwd: string;
  piArgs: string[];
  advisorMarker: string;
}): Promise<{ tabId: string; address: string; paneId: string; created: boolean }> {
  const created = await appDo(opts.exec, "tab.new", {
    name: opts.agentType,
    space: opts.spaceId,
    folder: opts.cwd,
    argv: opts.piArgs,
    focus: false,
  });
  if (!created.ok) throw new Error(`herdr-app tab.new failed: ${created.error}`);
  const tabId = created.data?.tab;
  const address = created.data?.terminal;
  if (!tabId || !address) {
    throw new Error("herdr-app tab.new: unexpected response shape (missing tab/terminal)");
  }
  // ponytail: no ADVISOR_MARKER_ENV for app-spawned children — herdr-core only
  // takes env at spawn via its JSON API, and neither `herdr-app tab.new` nor
  // the `hc run` CLI exposes one. The child's advisor therefore publishes no
  // marker, so awaitAdvisorCycle's grace poll returns 0 and collection happens
  // at first settle (the TUI backend's skip-path behaviour). Wire the env in
  // here once `hc run --env` lands (`awaitAdvisorCycle` already takes the file).
  return { tabId, address, paneId: "", created: true };
}

/** Spawn the child in a new pane of an EXISTING tab (parallel same-type). */
async function spawnInSplitPane(opts: {
  exec: HerdrExec;
  tabId: string;
  /** Anchor pane of that tab (from the caller's already-fetched listing). */
  anchorPane: string;
  cwd: string;
  piArgs: string[];
  direction: "right" | "down";
}): Promise<{ address: string; paneId: string }> {
  const anchorPane = opts.anchorPane;
  if (!anchorPane) throw new Error(`herdr-app: no panes found in tab ${opts.tabId}`);
  const split = await appDo(opts.exec, "pane.split", {
    direction: opts.direction,
    pane: anchorPane,
    argv: opts.piArgs,
  });
  if (!split.ok) throw new Error(`herdr-app pane.split failed: ${split.error}`);
  const paneId = split.data?.pane;
  const address = split.data?.terminal;
  if (!address) throw new Error("herdr-app pane.split: unexpected response shape (missing terminal)");
  return { address, paneId: paneId ?? "" };
}

// ponytail: per-agent-type serialization, herdr.ts prepareChains precedent —
// concurrent same-type dispatch would race tab create / name allocation; the
// expensive part (prompt + run) stays parallel.
const prepareChains = new Map<string, Promise<HerdrAppHandle>>();

async function prepareHerdrAppTaskUncached(opts: PrepareHerdrAppTaskOptions): Promise<HerdrAppHandle> {
  const exec = herdrAppCli.exec;
  if (Buffer.byteLength(opts.task, "utf8") > HERDR_TASK_BUDGET) {
    throw new Error(`herdr-app task exceeds the ${HERDR_TASK_BUDGET}-byte budget (delivery wrapper included) — shorten the task or use runner:"sdk".`);
  }
  const liveIds = await liveTerminalIds(exec);
  const name = allocateName(opts.agentType, [...liveIds, ...registry.keys()]);
  const stamp = dispatchStamp();
  const handle: HerdrAppHandle = {
    tabName: opts.agentType,
    tabId: "",
    address: "",
    paneId: "",
    name,
    agentType: opts.agentType,
    task: opts.task,
    resultFile: resultFilePath(opts.cwd, name, stamp),
    advisorMarker: advisorMarkerPath(opts.cwd, stamp),
    readOnly: opts.readOnly,
    model: opts.model ?? "",
    thinking: opts.thinking,
    timeoutMs: opts.timeoutMs,
    tabCreatedHere: true,
  };
  registry.set(handle.name, handle);
  try {
    await fs.mkdir(path.dirname(handle.resultFile), { recursive: true });
    const systemPromptFile = path.join(path.dirname(handle.resultFile), `${name}.system.md`);
    await fs.writeFile(systemPromptFile, opts.systemPrompt, "utf8");
    // Build argv BEFORE topology so arg validation failures (read-only sandbox
    // with no allowed tools) leave no orphan tab behind.
    const piArgs = buildAppPiArgs({
      name,
      systemPromptFile,
      model: opts.model,
      thinking: opts.thinking,
      tools: opts.tools,
      readOnly: opts.readOnly,
      sessionStamp: stamp,
    });
    const found = await resolveSpaceAndTab(exec, opts.agentType);
    const existing = found.tab;
    if (existing && existing.terminals.length > 0) {
      // Adopt: same agent type already has a tab (this session or a previous
      // one). Never ours to close; add a pane beside the existing work.
      const direction = existing.terminals.length % 2 === 1 ? "right" : "down";
      const split = await spawnInSplitPane({
        exec,
        tabId: existing.id,
        anchorPane: existing.terminals[existing.terminals.length - 1]!.pane,
        cwd: opts.cwd,
        piArgs,
        direction,
      });
      handle.tabId = existing.id;
      handle.tabCreatedHere = false;
      handle.address = split.address;
      handle.paneId = split.paneId;
    } else {
      const space = found.space;
      if (!space) {
        throw new Error("herdr-app: no window/space is open — open the Herdr app (or use runner:\"sdk\").");
      }
      const spawned = await spawnInNewTab({
        exec,
        agentType: opts.agentType,
        spaceId: space.id,
        cwd: opts.cwd,
        piArgs,
        advisorMarker: handle.advisorMarker,
      });
      handle.tabId = spawned.tabId;
      handle.address = spawned.address;
      handle.paneId = spawned.paneId;
    }
    return handle;
  } catch (err) {
    registry.delete(handle.name);
    throw err;
  }
}

export function prepareHerdrAppTask(opts: PrepareHerdrAppTaskOptions): Promise<HerdrAppHandle> {
  const prev = prepareChains.get(opts.agentType) ?? Promise.resolve(null as unknown as HerdrAppHandle);
  const job = prev.then(
    () => prepareHerdrAppTaskUncached(opts),
    () => prepareHerdrAppTaskUncached(opts),
  );
  prepareChains.set(opts.agentType, job);
  job.catch(() => { /* stored chain must not reject unhandled */ });
  return job;
}

// ---------------------------------------------------------------------------
// Prompt + wait
// ---------------------------------------------------------------------------

/** Task + delivery contract (identical wording to the TUI backend). */
export function wrapAppTaskPrompt(task: string, resultFile: string, readOnly = false): string {
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

/**
 * Submit the task and wait for that turn to settle.
 *
 * `hc send --wait` follows the turn the send started (herdr-core tracks 7501
 * turns), so no baseline/evidence machinery is needed — the TUI backend's
 * stall workaround exists only because herdr 0.9.x never reports `working`
 * for pi panes.
 */
export async function promptAppAndWait(opts: {
  address: string;
  text: string;
  timeoutMs: number;
  exec: HerdrExec;
  signal?: AbortSignal;
}): Promise<PromptOutcome> {
  if (opts.signal?.aborted) {
    return { state: "unknown", delivered: false, error: "aborted: parent operation aborted" };
  }
  // Readiness gate. `hc send` pastes into whatever is on screen; against a pi
  // that is still booting the paste can land before the composer is live and
  // the submit never registers (live incident 2026-11-17: the task sat unsent
  // in the child's composer, `hc send --wait` still reported a settled turn,
  // and the parent collected its own echoed task as "success"). The TUI backend
  // gets this for free — `herdr agent start` waits for readiness — so the app
  // path must wait explicitly (the hc manual's own advice).
  const ready = await waitForReady(opts.address, opts.exec, opts.signal);
  if (!ready.ok) {
    return { state: ready.state, delivered: false, error: ready.error };
  }
  const baselineTurn = ready.turn;
  const seconds = Math.max(5, Math.ceil(opts.timeoutMs / 1000));
  const res = await opts.exec(
    HC_BIN,
    ["send", opts.address, opts.text, "--wait", "--timeout", String(seconds), "--json"],
    { timeout: opts.timeoutMs + 20_000 },
  );
  // hc writes errors as JSON on STDERR; a failed call's stdout is not a reply.
  const data = parseJson((res.code === 0 ? res.stdout : res.stderr).trim() || res.stdout.trim());
  const errKind = data?.error?.kind;
  if (res.code !== 0) {
    if (errKind === "blocked") {
      return { state: "blocked", delivered: false, error: "Agent is blocked on a dialog — answer it in its pane, then prompt again." };
    }
    if (errKind === "not_found") {
      return { state: "unknown", delivered: false, error: data?.error?.message ?? "terminal not found" };
    }
    if (errKind === "status_mismatch" || errKind === "finished") {
      return { state: "unknown", delivered: false, error: data?.error?.message ?? `send refused (${errKind})` };
    }
    return { state: "unknown", delivered: false, error: data?.error?.message ?? firstLine(res) };
  }
  const wait = data?.wait;
  if (wait?.reason === "timeout") {
    return {
      state: await settledState(opts.address, opts.exec),
      delivered: true,
      error: `timeout after ${opts.timeoutMs}ms`,
    };
  }
  const status = wait?.status;
  const state: HerdrAgentState =
    status === "idle" || status === "done" || status === "blocked" || status === "working"
      ? status
      : await settledState(opts.address, opts.exec);
  if (data?.started === false || wait?.reason === "not_started") {
    return { state, delivered: false, error: "the agent did not start working on the task (it may be waiting for input)" };
  }
  // Turn-advance proof: the child only advances its turn when it actually
  // works. A "settled" reply with an unchanged turn means the paste never
  // submitted — report that instead of collecting the echoed task as success.
  const turnAfter = typeof wait?.turn === "number" ? wait.turn : undefined;
  if (turnAfter !== undefined && turnAfter <= baselineTurn) {
    return {
      state,
      delivered: false,
      error: `the task was pasted but never submitted (turn still ${turnAfter}) — the child was not ready or a dialog holds the composer; prompt it again in its pane`,
    };
  }
  return { state, delivered: true };
}

/** Poll until the terminal reports as a READY pi (idle, status-reporting). */
async function waitForReady(
  address: string,
  exec: HerdrExec,
  signal?: AbortSignal,
): Promise<{ ok: true; state: HerdrAgentState; turn: number } | { ok: false; state: HerdrAgentState; error: string }> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let last: HerdrAppTerminal | undefined;
  for (;;) {
    if (signal?.aborted) return { ok: false, state: "unknown", error: "aborted: parent operation aborted" };
    const got = await hcJson(exec, ["get", address], 10_000);
    if (got.ok) {
      const t = got.data?.result ?? got.data;
      const raw = t?.status?.state;
      const status: HerdrAgentState =
        raw === "idle" || raw === "done" || raw === "blocked" || raw === "working" ? raw : "unknown";
      last = {
        address: t?.address ?? address,
        status,
        app: t?.status?.app ?? null,
        state: t?.state === "live" || t?.state === "finished" ? t.state : "unknown",
      };
      if (last.state === "finished") {
        return { ok: false, state: "unknown", error: "the child terminal exited before its task was sent" };
      }
      // Ready for input: a live pi at rest. `done` counts — pi reports "done"
      // for a turn that finished while nobody was watching, and that composer
      // accepts input exactly like `idle` (live 2026-11-17: accepting only
      // `idle` made every follow-up prompt to an already-settled agent fail
      // the readiness gate and time out). `working`/`blocked` are NOT ready.
      if (t?.status?.app === "pi" && (status === "idle" || status === "done")) {
        return { ok: true, state: status, turn: typeof t?.turn === "number" ? t.turn : 0 };
      }
    }
    if (Date.now() >= deadline) {
      return {
        ok: false,
        state: last?.status ?? "unknown",
        error: `the child did not become ready for input within ${Math.round(READY_TIMEOUT_MS / 1000)}s${last?.status ? ` (last state: ${last.status})` : ""} — check its pane`,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
}

async function settledState(address: string, exec: HerdrExec): Promise<HerdrAgentState> {
  const info = await getTerminal(address, exec);
  return info?.status ?? "unknown";
}

// ---------------------------------------------------------------------------
// Collection & cancel
// ---------------------------------------------------------------------------

/** Report file first (delivery contract), pane tail as best-effort fallback. */
export async function collectAppResult(opts: {
  handle: HerdrAppHandle;
  exec: HerdrExec;
}): Promise<{ output: string; source: "file" | "pane" | "none" }> {
  const fromFile = await readReportFile(opts.handle.resultFile);
  if (fromFile) return { output: fromFile, source: "file" };
  const read = await opts.exec(HC_BIN, ["read", opts.handle.address, "--lines", "200"], { timeout: 15_000 });
  const paneText = read.code === 0 ? read.stdout.trim() : "";
  if (!paneText) return { output: "", source: "none" };
  // A pane holding only our own task echo (plus pi's startup chrome) is NOT a
  // reply — that is the paste-never-submitted failure. Report no output so the
  // caller fails loudly instead of returning the echo as a successful report.
  const reply = replyBeyondEcho(paneText, opts.handle.task);
  // A pane holding only our task echo (plus pi's chrome) is NOT a reply — the
  // paste-never-submitted failure. Fail loudly instead of returning the echo.
  if (!reply) return { output: "", source: "none" };
  return { output: capPaneCapture(reply), source: "pane" };
}

/**
 * The pane's reply, or "" when the pane holds nothing but our echoed task
 * (the TUI backend's F10 rule: a settled echo is not a reply).
 *
 * Strategy — the reply is always AFTER our own text, so cut rather than
 * subtract: find where our task + delivery contract ends and keep the tail.
 * Everything before that point is boot chrome, resource lists and the paste
 * itself, and the composer/status footer is dropped from the end. Subtracting
 * known noise patterns instead kept leaking list continuations into the
 * answer and, once tightened, ate the reply itself (live 2026-11-17).
 */
function replyBeyondEcho(paneText: string, task: string): string {
  // The composer line marks the end of the transcript region.
  const lines = paneText.split("\n");
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*[\u03c0]\s*>/.test(lines[i]!)) { end = i; break; }
  }
  const region = lines.slice(0, end);

  // The task + contract together are the last thing WE insert. Locate the
  // first line of the task text (whitespace-tolerant, the TUI wraps it) and
  // the end of the delivery contract that follows it.
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const flat = region.join("\n");
  const flatNorm = norm(flat);

  const contractEnd = (() => {
    const re = /Delivery: [\s\S]*?(?:corrected version\.|final message\.)/g;
    let last = -1;
    for (const m of flatNorm.matchAll(re)) last = (m.index ?? 0) + m[0].length;
    return last;
  })();
  if (contractEnd < 0) return ""; // no contract seen → not a dispatched turn

  // Everything after the contract in the flattened capture is ours to read,
  // minus hc's closing wrapper tag.
  const tail = flatNorm
    .slice(contractEnd)
    .replace(/<\/?hc[^>]*>/g, " ")
    // Status/footer chatter that follows the answer on the same capture.
    .replace(/\u2191[\d.]+K?\s*\u2193[\d.]+[\s\S]*$/g, "")
    .replace(/[\u03c0]\s*>.*$/g, "")   // composer (if it survived flattening)
    .trim();
  if (tail) return tail;

  // No contract (e.g. a follow-up the user typed): fall back to the text after
  // the task echo, ignoring pure-chrome lines.
  const at = task ? flatNorm.indexOf(norm(task)) : -1;
  if (at < 0) return "";
  return flatNorm.slice(at + norm(task).length).replace(/<\/?hc[^>]*>/g, " ").trim();
}

/**
 * Interrupt a delegated agent. herdr-core's `interrupt` presses the program's
 * own stop key (esc for an OSC-reporting program, else ctrl+c) and never
 * escalates — so a still-working terminal additionally gets `kill`, the app
 * equivalent of the TUI backend's esc→ctrl+c escalation.
 */
export async function cancelAppAgent(address: string, exec: HerdrExec = herdrAppCli.exec): Promise<void> {
  const res = await exec(HC_BIN, ["interrupt", address, "--json"], { timeout: 20_000 });
  if (res.code !== 0) return;
  const data = parseJson(res.stdout.trim());
  const stillWorking = data?.status === "working" || data?.working === true;
  if (!stillWorking) return;
  try {
    const info = await getTerminal(address, exec);
    if (!isSettled(info)) await exec(HC_BIN, ["kill", address, "--json"], { timeout: 20_000 });
  } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// High-level flow
// ---------------------------------------------------------------------------

export interface ExecuteHerdrAppTaskOptions {
  exec?: HerdrExec;
  onState?: (state: string) => void;
  signal?: AbortSignal;
  advisorWaitMs?: number;
  onAdvisorPhase?: (phase: string) => void;
}

/** Prompt the prepared agent, wait for settle, collect the report. */
export async function executeHerdrAppTask(
  handle: HerdrAppHandle,
  opts: ExecuteHerdrAppTaskOptions = {},
): Promise<SubAgentResult> {
  const exec = opts.exec ?? herdrAppCli.exec;
  const startedAt = Date.now();
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let lastState = "";
  let pollInFlight = false;
  const poll = async () => {
    if (pollInFlight) return;
    pollInFlight = true;
    try {
      const state = await settledState(handle.address, exec);
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
    const prompt = await promptAppAndWait({
      address: handle.address,
      text: wrapAppTaskPrompt(handle.task, handle.resultFile, handle.readOnly),
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
      await cancelAppAgent(handle.address, exec);
      prompt.error = `${prompt.error} (pane interrupted; it may still complete its current write — check ${path.basename(handle.resultFile)} or the pane before re-dispatching)`;
    } else if (!aborted) {
      advisorRounds = await awaitAdvisorCycle({
        name: handle.address,
        markerFile: handle.advisorMarker,
        advisorWaitMs: opts.advisorWaitMs ?? 0,
        signal: opts.signal,
        onPhase: opts.onAdvisorPhase,
        getState: () => settledState(handle.address, exec),
      });
      const collected = await collectAppResult({ handle, exec });
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

/** Busy siblings in a tab (closing a tab kills every pane in it). */
export async function appTabCloseBlockers(
  handle: HerdrAppHandle,
  exec: HerdrExec,
): Promise<{ siblings: string[]; self: string | undefined }> {
  const siblings: string[] = [];
  for (const entry of registry.values()) {
    if (entry.tabId !== handle.tabId || entry.address === handle.address) continue;
    const info = await getTerminal(entry.address, exec);
    // Fail closed: only an observed settled state proves the sibling is free.
    if (!isSettled(info)) siblings.push(entry.name);
  }
  const selfInfo = await getTerminal(handle.address, exec);
  const self = selfInfo && !isSettled(selfInfo) ? selfInfo.status ?? "unknown" : undefined;
  return { siblings, self };
}

/** Raise the agent's tab in the app window. */
export async function focusAppTab(tabId: string, exec: HerdrExec): Promise<{ ok: boolean; error?: string }> {
  const res = await appDo(exec, "tab.select", { id: tabId }, 15_000);
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

/** Close a tab this session created (and the terminals in it). */
export async function closeAppTab(tabId: string, exec: HerdrExec): Promise<{ ok: boolean; error?: string }> {
  const res = await appDo(exec, "tab.close", { id: tabId, confirmed: true }, 30_000);
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

/** Best-effort pane/screen text for one terminal. */
export async function readAppTerminal(
  address: string,
  lines: number,
  exec: HerdrExec,
): Promise<{ ok: boolean; text: string }> {
  const clamped = Math.min(Math.max(Math.trunc(lines), 1), 1000);
  const res = await exec(HC_BIN, ["read", address, "--lines", String(clamped)], { timeout: 15_000 });
  return {
    ok: res.code === 0,
    text: res.code === 0 ? res.stdout.slice(0, MAX_REPORT_BYTES) : firstLine(res),
  };
}

/** Submit a follow-up prompt without waiting (control tool, wait:false). */
export async function sendAppPrompt(address: string, text: string, exec: HerdrExec): Promise<{ ok: boolean; error?: string }> {
  const res = await exec(HC_BIN, ["send", address, text, "--json"], { timeout: 20_000 });
  if (res.code === 0) return { ok: true };
  const data = parseJson(res.stderr.trim() || res.stdout.trim());
  return { ok: false, error: data?.error?.message ?? firstLine(res) };
}
