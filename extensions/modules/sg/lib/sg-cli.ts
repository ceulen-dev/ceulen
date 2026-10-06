// The `sg`/`ast-grep` CLI runner — the single seam every op goes through
// (gh-module pattern: injected fake in tests). Zero deps.
//
// Env contract: NO_COLOR/CLICOLOR/CLICOLOR_FORCE pinned OFF — the user's
// CLICOLOR_FORCE=1 otherwise colorizes piped JSON and breaks parsing (the
// live gh bug, same fix).

import { spawn, spawnSync } from "node:child_process";

/** Deadline for one sg invocation. */
export const SG_TIMEOUT_MS = 30_000;
/** Captured-output cap per stream. */
export const SG_OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024;
const TRUNCATION_MARKER = "\n[sg output truncated after 2 MiB]\n";

/** sg / ast-grep with color forced OFF. */
export function sgEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NO_COLOR: "1",
    CLICOLOR: "0",
    CLICOLOR_FORCE: "0",
  };
}

export interface SgCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** The seam every op goes through — swapped for a fake in tests. */
export interface SgRunner {
  /** Run sg; does NOT throw on non-zero exit. */
  run(cwd: string, args: string[], signal?: AbortSignal): Promise<SgCommandResult>;
}

let availableCache: string | null | undefined;

/**
 * Resolve the sg binary: `ast-grep` first (the maintained name; `sg` prints a
 * deprecation warning to stderr on every call), falling back to `sg`. Cached.
 * Null when neither is installed (module registration is fail-open on this).
 */
export function sgBinary(): string | null {
  if (availableCache !== undefined) return availableCache;
  availableCache = null;
  for (const bin of ["ast-grep", "sg"]) {
    try {
      const probe = spawnSync(bin, ["--version"], { stdio: "ignore", timeout: 10_000 });
      if (!probe.error && probe.status === 0) {
        availableCache = bin;
        break;
      }
    } catch {
      // try the next candidate
    }
  }
  return availableCache;
}

/** Test hook: forget the probed binary (module state outlives a test). */
export function resetSgBinaryCache(): void {
  availableCache = undefined;
}

/** True when an sg CLI is installed (cached after the first probe). */
export function sgAvailable(): boolean {
  return sgBinary() !== null;
}

export const realSg: SgRunner = {
  run(cwd, args, signal) {
    const bin = sgBinary();
    if (!bin) {
      return Promise.reject(new Error("ast-grep CLI is not installed — install with `brew install ast-grep` or `npm i -g @ast-grep/cli`."));
    }
    return new Promise<SgCommandResult>((resolveP, rejectP) => {
      const timeout = AbortSignal.timeout(SG_TIMEOUT_MS);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const child = spawn(bin, args, { cwd, env: sgEnv(), stdio: ["ignore", "pipe", "pipe"], signal: combined });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let outTotal = 0;
      let errTotal = 0;
      child.stdout!.on("data", (chunk: Buffer) => {
        outTotal += chunk.length;
        if (outTotal <= SG_OUTPUT_LIMIT_BYTES) out.push(chunk);
      });
      child.stderr!.on("data", (chunk: Buffer) => {
        errTotal += chunk.length;
        if (errTotal <= SG_OUTPUT_LIMIT_BYTES) err.push(chunk);
      });
      child.on("error", rejectP);
      child.on("close", (code) => {
        let stdout = Buffer.concat(out).toString("utf8");
        if (outTotal > SG_OUTPUT_LIMIT_BYTES) stdout += TRUNCATION_MARKER;
        let stderr = Buffer.concat(err).toString("utf8");
        if (errTotal > SG_OUTPUT_LIMIT_BYTES) stderr += TRUNCATION_MARKER;
        resolveP({ exitCode: code ?? -1, stdout, stderr });
      });
    });
  },
};
