// shells — background shell sessions (Claude Code BashOutput/KillShell parity).
//
// ALL pure logic lives here and is exported for tests: RingBuffer (line
// buffering + hard byte cap with head+tail split), ShellSession, SessionStore
// (live-session cap, killAll with escalation, evict-oldest-exited), the
// monotonic id counter, name-aware id resolution, and createSession — the
// spawn seam (takes a spawn fn so tests inject fakes or `node -e` commands).

import type { ChildProcess } from "node:child_process";
import type { EventEmitter } from "node:events";

/** Hard cap per stream buffer. Beyond it: keep head + tail, drop the middle. */
export const TOTAL_BYTES = 262_144;
/** Bytes kept from the START of the stream when the cap is exceeded. */
export const HEAD_KEEP_BYTES = 4096;

/** The `[… N bytes truncated …]` divider inserted where the middle was dropped. */
export function truncationMarker(bytes: number): string {
  return `[… ${bytes} bytes truncated …]`;
}

function trimPartialHead(lines: string[], total: number, keep: number): { lines: string[]; total: number } {
  let dropped = 0;
  while (lines.length > 0 && total - dropped > keep) {
    dropped += Buffer.byteLength(lines[0], "utf8") + 1;
    lines.shift();
  }
  return { lines, total: total - dropped };
}

/**
 * Line-buffered ring for one output stream. `push` splits on \n and keeps the
 * partial tail until its newline arrives. When total bytes exceed TOTAL_BYTES
 * the stored lines become: first bytes + marker + last bytes (bash-tool
 * truncation semantics), re-checked after every push.
 */
export class RingBuffer {
  private linesArr: string[] = [];
  private partial = ""; // unterminated tail not yet a line
  private totalBytes = 0;
  private lifetimeBytes = 0;
  private capped = false;

  push(chunk: string): void {
    // A previous unterminated tail continues with this chunk's first line.
    const parts = (this.partial + chunk).split("\n");
    this.partial = "";
    this.partial = parts.pop() ?? "";
    for (const line of parts) this.linesArr.push(line);
    this.totalBytes += Buffer.byteLength(chunk, "utf8");
    this.lifetimeBytes += Buffer.byteLength(chunk, "utf8");
    if (this.totalBytes > TOTAL_BYTES) this.enforceCap();
  }

  private enforceCap(): void {
    this.capped = true;
    const lineBytes = (ls: string[]) => ls.reduce((n, l) => n + Buffer.byteLength(l, "utf8") + 1, 0);
    const keepTail = TOTAL_BYTES - HEAD_KEEP_BYTES - Buffer.byteLength(truncationMarker(1), "utf8") - 1;
    // Split the whole lines into HEAD (first bytes) + TAIL (last bytes),
    // dropping the middle; the first line of each side is taken even when it
    // alone busts its budget (one giant line must still be visible).
    let head: string[] = [];
    const tail: string[] = [];
    let tailBytes = 0;
    const rest = [...this.linesArr];
    while (rest.length > 0) {
      const l = rest[rest.length - 1]!;
      const b = Buffer.byteLength(l, "utf8") + 1;
      if (tailBytes + b > keepTail && tail.length > 0) break;
      tail.unshift(l);
      rest.pop();
      tailBytes += b;
    }
    let headBytes = 0;
    while (rest.length > 0) {
      const l = rest[0]!;
      const b = Buffer.byteLength(l, "utf8") + 1;
      if (headBytes + b > HEAD_KEEP_BYTES && head.length > 0) break;
      head.push(l);
      rest.shift();
      headBytes += b;
    }
    const droppedBytes = lineBytes(rest);
    this.linesArr = [...head, truncationMarker(Math.max(droppedBytes, 1)), ...tail];
    this.totalBytes = lineBytes(this.linesArr);
  }

  /** Everything visible so far: complete lines plus the unterminated tail. */
  lines(): string[] {
    return this.capAware();
  }

  /** Bytes written to this stream over its lifetime (pre-truncation). */
  totalWritten(): number {
    return this.lifetimeBytes;
  }

  /** True once the cap has been enforced at least once. */
  isTruncated(): boolean {
    return this.capped;
  }

  /** The unterminated tail, if any (exposed for tests/debugging). */
  peekPartial(): string {
    return this.partial;
  }

  private capAware(): string[] {
    if (this.capped) return [...this.linesArr];
    const out = this.partial ? [...this.linesArr, this.partial] : [...this.linesArr];
    return out;
  }
}

export interface ShellSession {
  id: string;
  name?: string;
  pid: number;
  child: ChildProcess;
  cwd: string;
  command: string;
  startedAt: number;
  exitedAt?: number;
  exitCode?: number | null;
  stdout: RingBuffer;
  stderr: RingBuffer;
  /** Output cursor for `since: "last"` — lines already returned by an output call. */
  lastOutputOffset: number;
}

// ---------------------------------------------------------------------------
// ID resolution + store

/** `nextId()` → "s1", "s2", … Monotonic module counter (never resets). */
let counter = 0;
export function nextId(): string {
  counter += 1;
  return `s${counter}`;
}

/** Test/‌multi-store hook: reset the id counter to n (default 0). */
export function resetIdCounter(n = 0): void {
  counter = n;
}

function fmtStatus(s: ShellSession): string {
  return s.exitedAt === undefined ? "running" : `exited code ${s.exitCode ?? "signal"}`;
}

/** One `id  name  status  uptime` summary line used in listings and errors. */
export function summarizeSession(s: ShellSession): string {
  const name = s.name ? `  ${s.name}` : "";
  return `${s.id}${name}  ${fmtStatus(s)}  ${s.command}`;
}

/** One `id  name  status` listing entry (no command). */
export function listSessionsLine(s: ShellSession): string {
  const name = s.name ? `  ${s.name}` : "";
  return `${s.id}${name}  ${fmtStatus(s)}`;
}

/**
 * Resolve idOrName: exact session id first, then a UNIQUE name match.
 * Throws (with the session list) on no match or an ambiguous name.
 */
export function resolveSession(store: SessionStore, idOrName: string): ShellSession {
  const byId = store.get(idOrName);
  if (byId) return byId;
  const byName = store.list().filter((s) => s.name === idOrName);
  if (byName.length === 1) return byName[0]!;
  const listing = store.list().map(listSessionsLine).join("\n") || "(no sessions)";
  if (byName.length > 1) {
    throw new Error(`session name '${idOrName}' is ambiguous (${byName.length} sessions):\n${listing}`);
  }
  throw new Error(`no session '${idOrName}'. Active sessions:\n${listing}`);
}

const MAX_LIVE_SESSIONS = 10;
const MAX_EXITED_SESSIONS = 5;
const EXIT_WAIT_MS = 2_000;

export class SessionStore {
  private map = new Map<string, ShellSession>();

  /** Register a session. Throws (listing live sessions) when 10 are already LIVE. */
  add(session: ShellSession): void {
    const live = this.list().filter((s) => s.exitedAt === undefined);
    if (live.length >= MAX_LIVE_SESSIONS && session.exitedAt === undefined) {
      const listing = live.map(listSessionsLine).join("\n");
      throw new Error(
        `refusing to start an 11th live shell session — kill one first (shell action:"kill"):\n${listing}`,
      );
    }
    this.map.set(session.id, session);
  }

  get(id: string): ShellSession | undefined {
    return this.map.get(id);
  }

  /** All sessions, oldest first (insertion order). */
  list(): ShellSession[] {
    return [...this.map.values()];
  }

  /** Replace a placeholder registration with the real session. */
  replace(id: string, session: ShellSession): void {
    this.map.delete(id);
    this.map.set(session.id, session);
  }

  /** Drop a session (spawn-failure cleanup, tests). */
  remove(id: string): void {
    this.map.delete(id);
  }

  /** Remove the OLDEST exited session if more than 5 have accumulated. */
  evictOldestExited(): ShellSession | undefined {
    const exited = this.list().filter((s) => s.exitedAt !== undefined);
    if (exited.length <= MAX_EXITED_SESSIONS) return undefined;
    const oldest = exited[0]!;
    this.map.delete(oldest.id);
    return oldest;
  }

  /**
   * Kill every live session's process GROUP (negative pid), falling back to
   * child.kill, then wait for exit (2s) and escalate to SIGKILL. Resolves
   * when all processes are gone (or unkillable — never rejects).
   */
  async killAll(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    await Promise.all(this.list().filter((s) => s.exitedAt === undefined).map((s) => killSession(s, signal)));
  }
}

/** Kill one session's process group, await exit, escalate to SIGKILL. */
export async function killSession(s: ShellSession, signal: NodeJS.Signals = "SIGTERM", waitMs = EXIT_WAIT_MS): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (s.exitedAt !== undefined) {
    return { code: s.exitCode ?? null, signal: null };
  }
  signalProcessGroup(s, signal);
  return await awaitExit(s, waitMs);
}

function signalProcessGroup(s: ShellSession, signal: NodeJS.Signals): void {
  // detached: true → the child leads its own process group; -pid signals the
  // whole group (the shell AND any grandchildren). Fall back to child.kill
  // when the group is gone (already reaped) or the call fails (Windows).
  try {
    process.kill(-s.pid, signal);
  } catch {
    try {
      s.child.kill(signal);
    } catch {
      // already dead — exit handling below deals with it
    }
  }
}

/** Await child exit; escalate to SIGKILL after waitMs. Never rejects. */
export function awaitExit(s: ShellSession, waitMs = EXIT_WAIT_MS): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolveP) => {
    const child = s.child;
    let done = false;
    const finish = (code: number | null, sig: NodeJS.Signals | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolveP({ code, signal: sig });
    };
    const timer = setTimeout(() => {
      signalProcessGroup(s, "SIGKILL");
      // Belt and braces: if even SIGKILL's exit event never lands, stop waiting.
      setTimeout(() => finish(null, "SIGKILL"), waitMs).unref?.();
    }, waitMs);
    timer.unref?.();
    child.once("exit", (code, sig) => finish(code, sig));
  });
}

// ---------------------------------------------------------------------------
// Session creation (the spawn seam — tests inject their own spawn fn)

export type SpawnFn = (command: string, options: { shell: boolean; cwd: string; env: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "pipe"]; detached: boolean }) => ChildProcess;

/**
 * Spawn `command` in its own process group, wire both streams into
 * RingBuffers, and register the session in `store`. Returns the session.
 * Throws a clean error when the spawn itself fails (bad cwd, etc.).
 */
export function createSession(
  store: SessionStore,
  spawnFn: SpawnFn,
  opts: { command: string; cwd: string; name?: string; env?: NodeJS.ProcessEnv },
): ShellSession {
  if (opts.name && store.list().some((s) => s.name === opts.name && s.exitedAt === undefined)) {
    const listing = store.list().map(listSessionsLine).join("\n");
    throw new Error(`a live session named '${opts.name}' already exists:\n${listing}`);
  }
  store.add({
    id: "",
    name: opts.name,
    pid: 0,
    child: {} as ChildProcess,
    cwd: opts.cwd,
    command: opts.command,
    startedAt: Date.now(),
    stdout: new RingBuffer(),
    stderr: new RingBuffer(),
    lastOutputOffset: 0,
  } as ShellSession); // placeholder so the live-cap check sees THIS session too
  const placeholder = store.list().at(-1)!;
  let child: ChildProcess;
  try {
    child = spawnFn(opts.command, {
      shell: true,
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
  } catch (err) {
    // Never leave a half-registered placeholder behind.
    store.remove(placeholder.id);
    throw new Error(`failed to start '${opts.command}': ${err instanceof Error ? err.message : String(err)}`);
  }
  const session: ShellSession = {
    ...placeholder,
    id: nextId(),
    pid: child.pid ?? 0,
    child,
  };
  store.replace(placeholder.id, session);
  child.stdout?.on("data", (d: Buffer) => session.stdout.push(d.toString()));
  child.stderr?.on("data", (d: Buffer) => session.stderr.push(d.toString()));
  child.on("exit", (code) => {
    session.exitedAt = Date.now();
    session.exitCode = code;
  });
  child.on("error", (err: Error) => {
    session.stderr.push(`[shells] spawn error: ${err.message}`);
  });
  return session;
}
