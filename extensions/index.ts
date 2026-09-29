/**
 * ceulen — the Pi coding agent, fully dressed.
 *
 * One bundle extension: consolidates the pi-extensions fleet into a single
 * entry with per-module kill-switches. Every module registers only through
 * Pi's public extension API — no core patches, so upstream Pi upgrades stay
 * drop-in.
 *
 * Modules land in waves. Wave 1: router + sub.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import routerModule from "./modules/router/index.ts";
import subModule, { loadCwdEnvFilesIfTrusted } from "./modules/sub/index.ts";
import ponytailModule from "./modules/ponytail/index.ts";

// ponytail: module registry grows by append — one object per module, loader
// stays ~10 lines forever, no plugin framework
const MODULES = [
  // Router first: sub reads the `router` provider for usage display.
  { name: "router", load: routerModule },
  { name: "sub", load: subModule },
  { name: "ponytail", load: ponytailModule },
  // { name: "notify", load: notifyModule },  // later wave
];

export default function ceulen(pi: ExtensionAPI) {
  // Kill-switch: "ceulen": { "disabled": ["sub"] } in settings.json skips those
  // modules entirely. Minimal form of the per-module toggle promise.
  // ponytail: SDK ExtensionAPI has no getSetting — read settings.json directly
  // (trusted repo scope, then agent dir), mirroring pi-evolve/pi-selfskills.
  const disabled = new Set(readDisabled());

  pi.registerCommand("ceulen", {
    description: "Ceulen config — module status",
    handler: async (_args, ctx) => {
      const active = MODULES.filter((m) => !disabled.has(m.name)).map((m) => m.name);
      const off = MODULES.filter((m) => disabled.has(m.name)).map((m) => m.name);
      ctx.ui.notify(
        `Ceulen ${active.length} module(s) active: ${active.join(", ")}` +
          (off.length ? ` · disabled: ${off.join(", ")}` : ""),
        "info",
      );
    },
  });

  // Trusted cwd .env ingestion must precede every module's session_start:
  // router reads ROUTER_BASE_URL/ROUTER_ENABLE_REASONING in its own handler, so
  // a trusted repo's .env loaded any later is invisible for the whole first
  // session. Registered first (handlers fire in registration order); sub keeps
  // its own idempotent call as a safety net when this entry is bypassed.
  pi.on("session_start", async (_event, ctx) => {
    loadCwdEnvFilesIfTrusted(ctx);
  });

  for (const m of MODULES) {
    if (disabled.has(m.name)) continue;
    try {
      m.load(pi);
    } catch (err) {
      console.error(`ceulen: module ${m.name} failed to load: ${err instanceof Error ? err.message : err}`);
    }
  }
}

/** Read the `ceulen.disabled` module list. <cwd>/.pi/settings.json is only
 *  eligible when the project is trusted (an untrusted checkout must not be
 *  able to re-enable or disable modules); otherwise agent-dir settings only. */
function readDisabled(): string[] {
  const dirs = process.env.PI_CODING_AGENT_DIR
    ? [process.env.PI_CODING_AGENT_DIR]
    : [path.join(os.homedir(), ".pi", "agent"), path.join(os.homedir(), ".pi", "agents")];
  const cwd = process.cwd();
  for (const file of [
    ...(isProjectTrusted(cwd, dirs) ? [path.join(cwd, ".pi", "settings.json")] : []),
    ...dirs.map((d) => path.join(d, "settings.json")),
  ]) {
    if (!existsSync(file)) continue;
    try {
      const raw = (JSON.parse(readFileSync(file, "utf8"))?.ceulen ?? {}) as { disabled?: unknown };
      return Array.isArray(raw.disabled) ? raw.disabled.filter((n): n is string => typeof n === "string") : [];
    } catch {
      return []; // malformed → defaults (all modules on)
    }
  }
  return [];
}

/** Project trust: read <agentDir>/trust.json ({ "<path>": true|false }),
 *  walking up the tree like pi's ProjectTrustStore. Unreadable/absent →
 *  false (fail closed). */
function isProjectTrusted(cwd: string, dirs: string[]): boolean {
  let current = path.resolve(cwd);
  for (const dir of dirs) {
    const file = path.join(dir, "trust.json");
    if (!existsSync(file)) continue;
    try {
      const data = JSON.parse(readFileSync(file, "utf8"));
      for (;;) {
        const v = data[current];
        if (typeof v === "boolean") return v;
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
      }
    } catch {
      return false;
    }
  }
  return false;
}
