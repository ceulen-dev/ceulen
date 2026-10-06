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

// ---------------------------------------------------------------------------
// Secret store: <agentDir>/.env.local — secrets NEVER land in settings.json
// ---------------------------------------------------------------------------

/** The secrets file next to the global settings.json. 0600, git-ignored by
 *  design (agent dir is never a repo), ingested into process.env at import by
 *  loadGlobalEnvFiles above — so env resolution, which already WINS over the
 *  settings layers in every module, serves these values unchanged. */
export function secretsEnvFile(agentDir?: string): string {
  const dir = agentDir ?? agentDirsForSecrets()[0]!;
  return path.join(dir, ".env.local");
}

function agentDirsForSecrets(): string[] {
  // Local import to avoid a cycle: registry.ts imports env.ts helpers? No —
  // env.ts is a leaf. Inline the same resolution (keeps env.ts import-free).
  return process.env.PI_CODING_AGENT_DIR
    ? [process.env.PI_CODING_AGENT_DIR]
    : [path.join(os.homedir(), ".pi", "agent"), path.join(os.homedir(), ".pi", "agents")];
}

/** Read the current secrets file as parsed entries ({} when absent). */
export function readSecretEnvs(agentDir?: string): Record<string, string> {
  return readEnvFile(secretsEnvFile(agentDir));
}

/** Upsert KEY=VALUE lines into <agentDir>/.env.local (other lines preserved),
 *  write atomically at 0600, and mirror into process.env so the LIVE session
 *  resolves the new secret immediately (file ingestion only runs at import).
 *  `onlyAbsent` keeps any existing value (migration semantics). */
export function writeSecretEnvs(entries: Record<string, string>, opts: { agentDir?: string; onlyAbsent?: boolean } = {}): string[] {
  const file = secretsEnvFile(opts.agentDir);
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch { /* absent — start fresh */ }
  const written: string[] = [];
  for (const [key, value] of Object.entries(entries)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue; // env-safe names only
    // A newline in the value would corrupt the line-based .env format (the
    // next read silently parses the remainder as garbage lines) — reject
    // rather than write a broken file. API keys/tokens/cookies never contain
    // newlines; a multiline PEM would need a different store anyway.
    if (/[\r\n]/.test(value)) continue;
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, "m");
    if (re.test(text)) {
      if (opts.onlyAbsent) continue;
      text = text.replace(re, line);
    } else {
      text += (text.endsWith("\n") || text === "" ? "" : "\n") + line + "\n";
    }
    written.push(key);
    if (process.env[key] === undefined || !opts.onlyAbsent) process.env[key] = value;
  }
  if (written.length === 0) return written;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return written;
}

/** web-module secret rows: settings key → env var (mirrors webRowSpecs'
 *  secret:true entries; keep in sync). */
const WEB_SECRET_ENV_BY_KEY: Record<string, string> = {
  "brave.apiKey": "BRAVE_API_KEY",
  "firecrawl.apiKey": "FIRECRAWL_API_KEY",
  "crawl4ai.apiToken": "CRAWL4AI_API_TOKEN",
  "gemini.cookie": "GEMINI_WEB_SECURE_1PSID",
  "image.zaiKey": "ZAI_API_KEY",
  "image.customKey": "WEB_IMAGE_API_KEY",
  "chat.apiKey": "WEB_CHAT_API_KEY",
};

/** One-time plaintext-secret migration out of the GLOBAL settings.json into
 *  <agentDir>/.env.local (env already wins at read time, so effective values
 *  are unchanged). Idempotent: a scrubbed key is absent next session, and
 *  onlyAbsent keeps any value the user hand-placed in .env.local first.
 *  Never throws — a failed migration leaves the (working) status quo. */
export function migrateSecretsFromSettings(): void {
  try {
    const dir = agentDirsForSecrets()[0]!;
    const settingsFile = path.join(dir, "settings.json");
    let settings: Record<string, any>;
    try {
      settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    } catch {
      return; // absent/corrupt — nothing to migrate
    }
    const migrate: Record<string, string> = {};
    const scrubWeb: string[] = [];
    // web section: flat or nested secret keys.
    const web = settings.web && typeof settings.web === "object" ? settings.web : {};
    for (const [key, envName] of Object.entries(WEB_SECRET_ENV_BY_KEY)) {
      let value: unknown = (web as Record<string, unknown>)[key];
      if (value === undefined && key.includes(".")) {
        let cur: unknown = web;
        for (const p of key.split(".")) {
          if (!cur || typeof cur !== "object") { cur = undefined; break; }
          cur = (cur as Record<string, unknown>)[p];
        }
        value = cur;
      }
      if (typeof value === "string" && value !== "") {
        migrate[envName] = value;
        scrubWeb.push(key);
      }
    }
    // a2a section: gateway tokens (legacy block + gateways map).
    const a2a = settings.a2a && typeof settings.a2a === "object" ? settings.a2a : {};
    const discovery = a2a.discovery && typeof a2a.discovery === "object" ? a2a.discovery : {};
    let a2aChanged = false;
    const gw = discovery.gateway && typeof discovery.gateway === "object" ? discovery.gateway : undefined;
    if (gw && typeof gw.token === "string" && gw.token !== "") {
      migrate.A2A_GATEWAY_TOKEN = gw.token;
      delete gw.token;
      a2aChanged = true;
    }
    if (gw && typeof gw.upstreamToken === "string" && gw.upstreamToken !== "") {
      migrate.A2A_GATEWAY_UPSTREAM_TOKEN = gw.upstreamToken;
      delete gw.upstreamToken;
      a2aChanged = true;
    }
    const gws = discovery.gateways && typeof discovery.gateways === "object" ? discovery.gateways : undefined;
    if (gws) {
      for (const [key, raw] of Object.entries(gws as Record<string, any>)) {
        if (!raw || typeof raw !== "object") continue;
        const keyEnv = key.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
        if (typeof raw.token === "string" && raw.token !== "") {
          migrate[`A2A_GATEWAY_${keyEnv}_TOKEN`] = raw.token;
          delete raw.token;
          a2aChanged = true;
        }
        if (typeof raw.upstreamToken === "string" && raw.upstreamToken !== "") {
          migrate[`A2A_GATEWAY_${keyEnv}_UPSTREAM_TOKEN`] = raw.upstreamToken;
          delete raw.upstreamToken;
          a2aChanged = true;
        }
      }
    }
    if (Object.keys(migrate).length === 0) return;
    // Ordering: env write FIRST, settings scrub second. If the process dies
    // between them the secret exists in both places — harmless (env wins at
    // read time) and the next session's migration scrubs again (idempotent).
    // The reverse order could LOSE a secret (scrubbed but never written).
    writeSecretEnvs(migrate, { agentDir: dir, onlyAbsent: true });
    // Scrub: rewrite settings.json WITHOUT the migrated secrets, atomically.
    if (scrubWeb.length > 0) {
      for (const key of scrubWeb) {
        delete (web as Record<string, unknown>)[key];
        const parts = key.split(".");
        if (parts.length < 2) continue;
        let cur: any = web;
        for (const p of parts.slice(0, -1)) {
          if (!cur[p] || typeof cur[p] !== "object") { cur = null; break; }
          cur = cur[p];
        }
        if (cur) delete cur[parts[parts.length - 1]!];
      }
      const prune = (node: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(node)) {
          if (v && typeof v === "object" && !Array.isArray(v)) {
            prune(v as Record<string, unknown>);
            if (Object.keys(v as Record<string, unknown>).length === 0) delete node[k];
          }
        }
      };
      prune(web as Record<string, unknown>);
      if (Object.keys(web).length === 0) delete settings.web;
    }
    if (scrubWeb.length === 0 && !a2aChanged) return;
    const tmp = settingsFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, settingsFile);
  } catch {
    /* never break startup over a migration */
  }
}
