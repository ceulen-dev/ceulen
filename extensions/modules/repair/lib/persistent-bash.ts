// persistent-bash.ts — one long-lived bash per pi session, so cwd, exported
// variables, functions, and background jobs survive across bash tool calls.
//
// Ported in behavior from DeepSeek Harness `@deepseek-ai/dsh-tool-bash-persistent`
// (packages/shell/tool-bash-persistent, DSH 0.2.3-alpha.1) onto pi's public
// `BashOperations` seam. DELIBERATE DEVIATIONS from DSH, each load-bearing:
//
//   1. Transport is pipes on a non-interactive `bash --noprofile --norc`, not a
//      PTY scrollback. No prompt detection, no `stty -echo`, no scrollback ring
//      to page: stdout/stderr are read directly and the command's exit status
//      arrives on a marker line. Same observable contract, far less machinery.
//   2. Each command is one physical line — `eval $'<ANSI-C-escaped body>'; printf
//      '<marker>%s\n' "$?"` (DSH's wrapCommand, kept verbatim in spirit). The
//      eval-$'…' wrap makes a syntactically incomplete command a bash SYNTAX
//      ERROR (the status printf still runs) instead of swallowing the marker.
//   3. No `PI_SESSION_ID` in `options.env` (ctx-less execution) falls back to a
//      shared `_default_` shell — a documented ceiling, not a crash.
//   4. No output clipping here: pi's bash tool already truncates to
//      DEFAULT_MAX_LINES/DEFAULT_MAX_BYTES and spills the rest to a temp file.
//      DSH clipped at 16000 chars because its own loop had no such stage.
//
// PLAN MODE delegates to the one-shot local operations (see exec below): the
// plan gate auto-allows reads by COMMAND TEXT, and a shell retaining a cwd,
// function, or alias exported before plan mode could change what that text
// actually does. Plan-mode mutations are therefore discarded (one-shot), while
// the persistent shell keeps its pre-plan state and resumes when plan mode ends.
//
// Reset, never repair (DSH's rule): `exit`, a timeout, an abort, a spawn
// failure, or EOF-before-marker kills the process GROUP (spawned detached, so
// children die too) and forgets the shell; the next call respawns fresh.

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { isPlanActive } from "../../../lib/plan-bridge.ts";

/** Marker prefix; the per-command nonce follows it (one token). */
const MARKER_PREFIX = "__CEULEN_PS_";
/** Key used when the caller supplied no PI_SESSION_ID (documented ceiling). */
const DEFAULT_KEY = "_default_";
/** Synthetic note appended when the shell died under a running command. */
const EXITED_NOTE = "\n[persistent shell exited — the next bash call starts a fresh shell in the session directory]\n";
/** Cap on retained between-command output (background-job noise guard). */
const PENDING_MAX_CHARS = 256 * 1024;
/**
 * Default per-command deadline when the caller supplies none (seconds).
 *
 * pi's bash `timeout` is OPTIONAL — undefined means the one-shot path has no
 * timer at all. For a persistent shell that is not survivable: a command that
 * never settles (a shadowed framing primitive, a foreground child reading
 * stdin, a runaway job) blocks the shell AND every queued call behind it
 * forever, with no reset to recover by. DSH's own tool-bash-persistent defaults
 * `timeoutMs` to 300 000 for exactly this reason. This is a FLOOR, not an
 * override: an explicit `timeout` always wins, and the timeout RESETS the shell
 * (reset-never-repair), which is what turns the `command`-shadow ceiling into a
 * bounded, self-healing failure instead of a wedged session.
 */
export const DEFAULT_COMMAND_TIMEOUT_SECS = 300;

/** The command currently owning this shell's stream, if any. */
interface ActiveCommand {
  marker: string;
  onData: (data: Buffer) => void;
  settle: (code: number) => void;
  /** Text held back until a newline proves it is not the marker. */
  carry: string;
  settled: boolean;
}

interface PersistentShell {
  child: ChildProcess;
  /** Output observed BETWEEN commands (background jobs). Prepended to the next
   *  command's stream so nothing is lost across calls (DSH parity). */
  pending: string;
  active: ActiveCommand | undefined;
  alive: boolean;
}

/** Per-shell bookkeeping keyed by pi session id. */
const shells = new Map<string, PersistentShell>();
/**
 * Serialization queues keyed by SESSION, not by shell object. A shell can be
 * reset (timeout/abort/exit) while calls are still queued behind it; keying the
 * queue on the shell would make those queued calls run against the dead child
 * ("persistent shell is not running") instead of respawning. Keeping the queue
 * on the key lets every dequeued call re-resolve the CURRENT shell.
 */
const queues = new Map<string, Promise<unknown>>();

/** Test seam: a fixed marker source (marker-collision coverage). */
export interface PersistentBashDeps {
  /** Returns the command's end marker (must start with `__CEULEN_PS_`). */
  newMarker?: () => string;
  /** Overrides DEFAULT_COMMAND_TIMEOUT_SECS (tests only — a lower floor keeps
   *  the never-settles coverage fast). */
  defaultTimeoutSecs?: number;
}

function defaultMarker(): string {
  return `${MARKER_PREFIX}${randomBytes(8).toString("hex")}__`;
}

/** Escape a command for bash's `$'…'` ANSI-C quoting (DSH quoteForBash). */
export function quoteForEval(command: string): string {
  let out = "";
  for (const ch of command) {
    if (ch === "\\") out += "\\\\";
    else if (ch === "'") out += "\\'";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else {
      const code = ch.codePointAt(0)!;
      if (code > 0 && code < 0x20) out += `\\x${code.toString(16).padStart(2, "0")}`;
      else out += ch;
    }
  }
  return `$'${out}'`;
}

/**
 * The one physical line sent to the shell (DSH wrapCommand).
 *
 * Every framing step is reached through `command builtin`, so each step
 * bypasses function AND alias lookup. The shell is persistent by design, so a
 * function the model defined in an earlier call is still live when the framing
 * runs. Probed shadowings, in escalating order of reach:
 *
 *   `printf() { :; }`  — suppressed the marker bare → a SUCCESSFUL command hung
 *                        until the timeout (the first reported defect);
 *   `eval() { … }`     — captured the body dispatch the same way;
 *   `builtin() { :; }` — ALSO suppressed it through `builtin printf`, because
 *                        `builtin` is itself resolved by NAME. `command` fixes
 *                        this one: with only `builtin` shadowed and `command`
 *                        intact the marker PRINTS.
 *   `command() { :; }` — THE REMAINING CEILING, and it needs no help from
 *                        `builtin`: `command` is resolved first and is itself
 *                        shadowable, so this alone SKIPS THE BODY and suppresses
 *                        the marker. Escaping it would need an absolute external
 *                        path (`/usr/bin/printf`), which is not portable to
 *                        every platform pi runs on — accepting a
 *                        deliberate-self-harm timeout beats framing that cannot
 *                        start on a box without that binary.
 *
 * The ceiling is self-limiting rather than silent: the offending call times out
 * (pi's "Command timed out after N seconds"), the timeout RESETS the shell
 * (reset-never-repair), and the next call therefore runs on a fresh shell with
 * the shadowing function gone — verified, including `type command` reporting
 * the builtin again. The model wrote the shadowing function, so this is
 * self-inflicted; the reset makes it self-healing.
 *
 * ponytail: body evaluation keeps `command builtin eval` for symmetry, but a
 * redirected command name INSIDE the body is the model's own doing, not framing.
 */
export function wrapCommand(command: string, marker: string): string {
  return `command builtin eval ${quoteForEval(command)}; command builtin printf '${marker}%s\\n' "$?"\n`;
}

/** Kill a process GROUP (spawned detached). Safe on an already-dead pid. */
function killGroup(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/** Forget (and kill) one shell, or all of them. */
export function killPersistentShells(sessionId?: string): void {
  const keys = sessionId === undefined ? [...new Set([...shells.keys(), ...queues.keys()])] : [sessionId];
  for (const key of keys) {
    // Drop the serialization chain too: a session that is killed must not
    // inherit a queue whose head can never settle.
    queues.delete(key);
    const shell = shells.get(key);
    if (!shell) continue;
    shells.delete(key);
    shell.alive = false;
    killGroup(shell.child);
  }
}

/**
 * Route one chunk of shell output. While a command owns the stream it is
 * forwarded with the trailing partial line held back (a marker split across
 * chunks must never be read as output); between commands everything lands in
 * `pending` for the next command to replay.
 */
function feed(shell: PersistentShell, chunk: string): void {
  const active = shell.active;
  if (!active || active.settled) {
    shell.pending = (shell.pending + chunk).slice(-PENDING_MAX_CHARS);
    return;
  }
  active.carry += chunk;
  const nl = active.carry.lastIndexOf("\n");
  if (nl < 0) return;
  const complete = active.carry.slice(0, nl + 1);
  active.carry = active.carry.slice(nl + 1);

  // LAST occurrence, not first: an earlier line carrying the marker token is
  // command OUTPUT, and settling on it would strand the rest of the output in
  // the next call's stream.
  // ponytail: the nonce is generated per command, AFTER the command text exists,
  // so a model cannot echo a marker it has never seen. A same-chunk echo is
  // handled by lastIndexOf; a CROSS-chunk echo would need a settle timer (DSH
  // polls its scrollback for exactly this reason). Accepted ceiling — a pipe
  // stream has no "nothing new for N ms" notion without one.
  const idx = complete.lastIndexOf(active.marker);
  if (idx < 0) {
    active.onData(Buffer.from(complete, "utf8"));
    return;
  }
  // Marker line: text before it is real output, the rest of that line is the
  // exit status, and anything still buffered belongs to a later call.
  const before = complete.slice(0, idx);
  if (before.length > 0) active.onData(Buffer.from(before, "utf8"));
  const afterMarker = complete.slice(idx + active.marker.length);
  const statusEnd = afterMarker.indexOf("\n");
  const status = afterMarker.slice(0, statusEnd);
  shell.pending = (afterMarker.slice(statusEnd + 1) + active.carry).slice(-PENDING_MAX_CHARS);
  active.carry = "";
  active.settle(Number.parseInt(status, 10));
}

function spawnShell(cwd: string, env: Record<string, string> | undefined): PersistentShell {
  const child = spawn("bash", ["--noprofile", "--norc"], {
    cwd,
    env: { ...(env ?? (process.env as unknown as Record<string, string>)) },
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  const shell: PersistentShell = { child, pending: "", active: undefined, alive: true };
  // ONE permanent pair of listeners per shell: output arriving between commands
  // is retained instead of dropped, and a command never attaches/detaches its
  // own listeners (which would race a chunk landing mid-attach).
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => feed(shell, chunk));
  child.stderr?.on("data", (chunk: string) => feed(shell, chunk));
  child.on("error", () => {
    shell.alive = false;
  });
  child.on("exit", () => {
    shell.alive = false;
    const active = shell.active;
    if (!active || active.settled) return;
    // The shell died under the command (exit, crash, or signal): report its
    // real status and tell the model the next call starts fresh.
    if (active.carry.length > 0) active.onData(Buffer.from(active.carry, "utf8"));
    active.carry = "";
    active.onData(Buffer.from(EXITED_NOTE, "utf8"));
    active.settle(shell.child.exitCode ?? 1);
  });
  // A dying shell's pipes must never crash the host (EPIPE on write).
  child.stdin?.on("error", () => {});
  child.stdout?.on("error", () => {});
  child.stderr?.on("error", () => {});
  return shell;
}

/** Resolve the shell for a key, spawning lazily and evicting dead ones. */
function shellFor(key: string, cwd: string, env: Record<string, string> | undefined): PersistentShell {
  const existing = shells.get(key);
  if (existing && existing.alive) return existing;
  if (existing) shells.delete(key);
  const shell = spawnShell(cwd, env);
  shells.set(key, shell);
  return shell;
}

/** Reset (kill + forget) a shell — the "never repair" half. */
function resetShell(key: string, shell: PersistentShell): void {
  shells.delete(key);
  shell.alive = false;
  killGroup(shell.child);
}

/** Run ONE command on an existing shell, resolving with its exit code and
 *  feeding output to `onData`. Rejects on timeout/abort after resetting it. */
function runOnShell(
  shell: PersistentShell,
  key: string,
  command: string,
  options: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number },
  marker: string,
): Promise<{ exitCode: number | null }> {
  return new Promise<{ exitCode: number | null }>((resolve, reject) => {
    if (!shell.alive || shell.child.stdin === null) {
      shells.delete(key);
      reject(new Error("persistent shell is not running"));
      return;
    }
    // Background-job output observed after the previous marker belongs to this
    // command's stream (DSH parity: nothing is lost between calls).
    if (shell.pending.length > 0) {
      options.onData(Buffer.from(shell.pending, "utf8"));
      shell.pending = "";
    }

    let timer: NodeJS.Timeout | undefined;
    const active: ActiveCommand = {
      marker,
      onData: options.onData,
      carry: "",
      settled: false,
      settle: (code: number) => {
        if (active.settled) return;
        active.settled = true;
        if (timer !== undefined) clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        if (shell.active === active) shell.active = undefined;
        if (!shell.alive) shells.delete(key);
        resolve({ exitCode: Number.isFinite(code) ? code : 1 });
      },
    };
    function onAbort(): void {
      if (active.settled) return;
      active.settled = true;
      if (timer !== undefined) clearTimeout(timer);
      shell.active = undefined;
      resetShell(key, shell);
      reject(new Error("aborted"));
    }

    shell.active = active;
    // `wrapWithPersistentShell` guarantees a positive timeout here: an explicit
    // caller timeout wins, otherwise the default FLOOR applies so a
    // never-settling command can never wedge the shell (and every queued call
    // behind it) forever. See DEFAULT_COMMAND_TIMEOUT_SECS.
    const timeoutSecs = options.timeout !== undefined && options.timeout > 0
      ? options.timeout
      : DEFAULT_COMMAND_TIMEOUT_SECS;
    timer = setTimeout(() => {
      if (active.settled) return;
      active.settled = true;
      shell.active = undefined;
      resetShell(key, shell);
      // pi's bash tool parses this exact prefix into its timeout message.
      reject(new Error(`timeout:${timeoutSecs}`));
    }, timeoutSecs * 1000);
    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      shell.child.stdin!.write(wrapCommand(command, marker));
    } catch {
      active.settled = true;
      if (timer !== undefined) clearTimeout(timer);
      shell.active = undefined;
      resetShell(key, shell);
      reject(new Error("persistent shell rejected input"));
    }
  });
}

/**
 * Wrap one-shot local bash operations with a per-session persistent shell.
 * `local` remains the spawn/fallback path AND the plan-mode one-shot path, so
 * a box without bash behaves exactly like the unwrapped tool.
 */
export function wrapWithPersistentShell(local: BashOperations, deps: PersistentBashDeps = {}): BashOperations {
  const newMarker = deps.newMarker ?? defaultMarker;
  const defaultTimeoutSecs = deps.defaultTimeoutSecs ?? DEFAULT_COMMAND_TIMEOUT_SECS;
  return {
    exec: (command, cwd, options) => {
      // Plan mode: one-shot, stateless. The plan gate auto-allows reads by
      // COMMAND TEXT; retained cwd/functions/aliases from before plan mode
      // could change what that text does, so nothing retained may be in play
      // while it gates. The persistent shell is left untouched (its pre-plan
      // state resumes on exit) and plan-mode mutations are discarded.
      if (isPlanActive()) return local.exec(command, cwd, options);

      const env = options.env as Record<string, string> | undefined;
      const key = env?.PI_SESSION_ID ?? DEFAULT_KEY;
      const marker = newMarker();
      const timeout = options.timeout ?? defaultTimeoutSecs;

      // Serialize per SESSION: parallel bash calls (a codemode batch) must never
      // interleave their streams on one shell. The shell is re-resolved INSIDE
      // the queue slot, so a call queued behind a reset (timeout/abort/exit)
      // respawns instead of running against the dead child. `catch` so a prior
      // failure never poisons the queue for the next command.
      const run = (queues.get(key) ?? Promise.resolve())
        .catch(() => undefined)
        .then(() => runOnShell(shellFor(key, cwd, env), key, command, { ...options, timeout }, marker));
      queues.set(key, run.then(
        () => undefined,
        () => undefined,
      ));
      return run;
    },
  };
}

/**
 * The bash-description addendum. Binds at module load so it stays byte-stable
 * in the cache-safe request head (the repair autoBg precedent). Teaches DSH's
 * backgrounding model — `&` inside the shell — and the reset contract.
 */
export function persistentBashClause(): string {
  return [
    "Commands run in ONE persistent bash session: the working directory, exported variables, functions, and",
    "background jobs persist across calls. Run long-lived commands in the background (e.g. 'sleep 10 &' or start",
    "a server with '&') and read their output on a later call. 'exit', a timeout, or an abort resets the shell —",
    "the next call starts fresh in the session's working directory. In plan mode each call runs as a one-shot shell.",
  ].join(" ");
}

/** Test seam: install the process-exit sweeper once per process. */
export function installPersistentExitSweepForTests(): void {
  installExitSweep();
}

function installExitSweep(): void {
  // Key the once-guard on a globalThis slot: a module-level flag RESETS on
  // /reload and would stack duplicate exit listeners on the shared process
  // (the autoBg/theme-slot pattern).
  const armed = Symbol.for("ceulen.repair.psExitSweep.armed");
  const host = globalThis as unknown as Record<symbol, boolean>;
  if (host[armed]) return;
  host[armed] = true;
  const sweep = () => killPersistentShells();
  process.once("exit", sweep);
  process.once("SIGTERM", sweep);
  process.once("SIGINT", sweep);
}
installExitSweep();
