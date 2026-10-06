// notify module — desktop notifications via osascript (macOS) / notify-send
// (Linux), terminal bell fallback everywhere else. Zero deps: everything
// spawns or writes "\x07". Always resolves; note carries the fallback reason.

import { spawn, spawnSync } from "node:child_process";

/** AppleScript string literal: wrap in "…", escape \ and ". */
export function appleQuote(s: string): string {
  return `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** AppleScript args for osascript: display notification <msg> with title <t>.
 *  AppleScript string literals need DOUBLE quotes — single quotes are a
  * syntax error (live-probed: 'x' → -2741, "x" → exit 0). */
export function buildDarwinArgs(title: string, message: string, sound: boolean): string[] {
  return [
    "-e",
    `display notification ${appleQuote(message)} with title ${appleQuote(title)}${sound ? ` sound name "Glass"` : ""}`,
  ];
}

/** notify-send args; app name "Pi" so the desktop shows a sane sender.
 *  ponytail: sound flag dropped — notify-send has no portable sound story. */
export function buildNotifySendArgs(title: string, message: string, _sound: boolean): string[] {
  return ["-a", "Pi", title, message];
}

/** Injectable seam — resolves when the notifier exits 0, rejects otherwise. */
export type SpawnFn = (cmd: string, args: string[]) => Promise<void>;

function defaultSpawn(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(cmd, args, { stdio: "ignore" });
    child.on("error", rejectP);
    child.on("close", (code) => {
      if (code === 0) resolveP();
      else rejectP(new Error(`${cmd} exited with code ${code}`));
    });
  });
}

/** PATH probe for the notifier binary (spawnSync --version, like ghAvailable). */
function defaultProbe(cmd: string): boolean {
  try {
    const probe = spawnSync(cmd, ["--version"], { stdio: "ignore", timeout: 5_000 });
    return !probe.error && probe.status === 0;
  } catch {
    return false;
  }
}

function bell(): void {
  process.stdout.write("\x07");
}

export interface NotifyOptions {
  title?: string;
  message: string;
  sound?: boolean;
  spawnFn?: SpawnFn;
  probeFn?: (cmd: string) => boolean;
  /** ponytail: injectable so the linux branches are testable on macOS. */
  platform?: NodeJS.Platform;
}

export interface NotifyResult {
  ok: boolean;
  via: "osascript" | "notify-send" | "bell";
  /** Set when we fell back — carries the failure / fallback text. */
  note?: string;
}

/** Send a desktop notification; never throws. Spawn or probe failure → bell. */
export async function notify(opts: NotifyOptions): Promise<NotifyResult> {
  const title = opts.title ?? "pi";
  const sound = opts.sound ?? false;
  const spawnFn = opts.spawnFn ?? defaultSpawn;
  const probeFn = opts.probeFn ?? defaultProbe;
  const platform = opts.platform ?? process.platform;
  try {
    if (platform === "darwin") {
      await spawnFn("osascript", buildDarwinArgs(title, opts.message, sound));
      return { ok: true, via: "osascript" };
    }
    if (platform === "linux") {
      if (!probeFn("notify-send")) {
        bell();
        return { ok: true, via: "bell", note: "notify-send not found on PATH — rang the terminal bell instead" };
      }
      await spawnFn("notify-send", buildNotifySendArgs(title, opts.message, sound));
      return { ok: true, via: "notify-send" };
    }
    bell();
    return { ok: true, via: "bell", note: `no desktop notifier on ${platform} — rang the terminal bell instead` };
  } catch (err) {
    bell();
    return { ok: true, via: "bell", note: err instanceof Error ? err.message : String(err) };
  }
}
