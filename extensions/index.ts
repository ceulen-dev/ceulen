/**
 * ceulen — the Pi coding agent, fully dressed.
 *
 * One bundle extension: feature modules loaded by a single entry, each with
 * a per-module kill-switch. Every module registers only through
 * Pi's public extension API — no core patches, so upstream Pi upgrades stay
 * drop-in.
 *
 * Modules land in waves. Wave 1: router + usage.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCwdEnvFilesIfTrusted } from "./lib/env.js";
import routerModule from "./modules/router/index.ts";
import usageModule from "./modules/usage/index.ts";
import ponytailModule from "./modules/ponytail/index.ts";

// Guards the ONE namespace bundle modules share: pi merges every module's
// registrations into a single extension object, where a duplicate name
// silently overwrites (Map.set). A claim by a DIFFERENT module throws;
// same-owner re-claims pass (router re-registers its provider at runtime).
// `owner` MUST be one map shared by every module in the load loop — created
// in ceulen() and passed in; per-module maps would make this a no-op.
// Exported for the guard contract test. ponytail: ~20-line ownership map,
// not a registration framework.
export function guarded(pi: ExtensionAPI, mod: string, owner: Map<string, string>): ExtensionAPI {
  const claim = (kind: string, nameOf: (first: never) => string, pass: (...args: never[]) => unknown) => (...args: never[]) => {
    const key = `${kind}:${nameOf(args[0])}`;
    const first = owner.get(key);
    if (first && first !== mod) throw new Error(`ceulen: module "${mod}" re-registered ${key} (already owned by "${first}")`);
    owner.set(key, mod);
    return pass(...args);
  };
  const keyOf = {
    command: (n: string) => n,
    tool: (t: { name: string }) => t.name,
    flag: (n: string) => n,
    shortcut: (k: string) => k,
    renderer: (t: string) => t,
    provider: (p: string | { name: string }) => (typeof p === "string" ? p : p.name),
  };
  return {
    ...pi,
    registerCommand: claim("command", keyOf.command, pi.registerCommand.bind(pi)),
    registerTool: claim("tool", keyOf.tool, pi.registerTool.bind(pi)),
    registerFlag: claim("flag", keyOf.flag, pi.registerFlag.bind(pi)),
    registerShortcut: claim("shortcut", keyOf.shortcut, pi.registerShortcut.bind(pi)),
    registerMessageRenderer: claim("renderer", keyOf.renderer, pi.registerMessageRenderer.bind(pi)),
    registerEntryRenderer: claim("entry-renderer", keyOf.renderer, pi.registerEntryRenderer.bind(pi)),
    registerProvider: claim("provider", keyOf.provider, pi.registerProvider.bind(pi)),
  } as ExtensionAPI;
}

// ponytail: module registry grows by append — one object per module, loader
// stays ~10 lines forever, no plugin framework
const MODULES = [
  // Router first: usage reads the `router` provider for usage display.
  { name: "router", load: routerModule },
  { name: "usage", load: usageModule },
  { name: "ponytail", load: ponytailModule },
  // { name: "notify", load: notifyModule },  // later wave
];

export default function ceulen(pi: ExtensionAPI) {
  // Kill-switch: "ceulen": { "disabled": ["usage"] } in settings.json skips those
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

  // One ownership map for the whole loop — this is what makes guarded() able
  // to see every module's claims (see guarded() docstring).
  const owner = new Map<string, string>();
  for (const m of MODULES) {
    if (disabled.has(m.name)) continue;
    try {
      m.load(guarded(pi, m.name, owner));
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
      if (!Array.isArray(raw.disabled)) return [];
      // ponytail: deprecated "sub" alias — the module was renamed to "usage"; drop when no settings ship it
      return raw.disabled.map((n) => (n === "sub" ? "usage" : n)).filter((n): n is string => typeof n === "string");
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
