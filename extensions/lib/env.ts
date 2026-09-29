// Bundle-level .env ingestion — trusted-gated. Shared by the bundle entry
// (which registers the session_start pass before every module, so
// session_start readers like router's ROUTER_BASE_URL see .env values) and by
// the usage module (which keeps an idempotent safety-net call in case the
// bundle entry is bypassed).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Parse .env-style text into KEY→VALUE entries: `export ` prefix allowed,
 *  single/double quotes stripped, comment/blank/non-assignment lines ignored.
 *  No inline-comment stripping (a `#` in the value stays part of the value).
 *  Exported for tests. */
export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/** Read a .env-style file into entries; missing/unreadable → {} (optional). */
function readEnvFile(file: string): Record<string, string> {
  try {
    return parseEnvText(fs.readFileSync(file, "utf8"));
  } catch {
    return {}; // optional file
  }
}

/** Keys injected at import from global env files. Trusted-project cwd files
 *  may still override these (the pre-gating cwd-first precedence); values from
 *  the real environment are never touched by either pass. */
const globalEnvFileKeys = new Set<string>();

/** Import-time pass: ONLY global/PI_CODING_AGENT_DIR env files. Cwd .env files
 *  are untrusted repo content — loading them here would let any repo inject
 *  ROUTER_MGMT_TOKEN, COMMAND_CODE_BASE_URL, etc. They load in session_start
 *  behind ctx.isProjectTrusted() instead (see loadCwdEnvFilesIfTrusted). */
function loadGlobalEnvFiles(): void {
  const dirs = process.env.PI_CODING_AGENT_DIR
    ? [process.env.PI_CODING_AGENT_DIR]
    : [path.join(os.homedir(), ".pi", "agent"), path.join(os.homedir(), ".pi", "agents")];
  for (const dir of dirs) {
    for (const file of [path.join(dir, ".env.local"), path.join(dir, ".env")]) {
      for (const [key, value] of Object.entries(readEnvFile(file))) {
        if (process.env[key] === undefined) {
          process.env[key] = value;
          globalEnvFileKeys.add(key);
        }
      }
    }
  }
}
loadGlobalEnvFiles();

let cwdEnvLoaded = false;

/** session_start pass: ingest cwd .env.local/.env, but ONLY for trusted
 *  projects. Idempotent (first trusted session wins), first-wins per candidate
 *  order, and never overrides the real environment. */
export function loadCwdEnvFilesIfTrusted(ctx: { isProjectTrusted?: () => boolean }): void {
  if (cwdEnvLoaded || ctx.isProjectTrusted?.() !== true) return;
  cwdEnvLoaded = true;
  for (const file of [path.resolve(process.cwd(), ".env.local"), path.resolve(process.cwd(), ".env")]) {
    for (const [key, value] of Object.entries(readEnvFile(file))) {
      if (process.env[key] === undefined || globalEnvFileKeys.has(key)) process.env[key] = value;
    }
  }
}
