/**
 * ceulen — the Pi coding agent, fully dressed.
 *
 * One bundle extension: feature modules loaded by a single entry, each with
 * a per-module kill-switch. Every module registers only through
 * Pi's public extension API — no core patches, so upstream Pi upgrades stay
 * drop-in.
 *
 * Modules land in waves. Wave 1: router + usage. Wave 2: ponytail. Wave 3: config.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadCwdEnvFilesIfTrusted } from "./lib/env.js";
import { MODULES, readDisabled, type ModuleConfig, type ModuleLoadDeps } from "./lib/registry.js";

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
          (off.length ? ` · disabled: ${off.join(", ")}` : "") +
          "\nConfigure: /config",
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
  // Per-module config contribution factories, closed over THAT module's guarded
  // pi (router's save re-registers its provider — a claim that must stay the
  // router module's). The config module receives this map and calls the
  // factories per /config open.
  const configContribs = new Map<string, () => ModuleConfig>();
  const deps: ModuleLoadDeps = { configContribs };
  for (const m of MODULES) {
    if (disabled.has(m.name)) continue;
    const g = guarded(pi, m.name, owner);
    if (m.config) configContribs.set(m.name, () => m.config!(g));
    try {
      m.load(g, deps);
    } catch (err) {
      console.error(`ceulen: module ${m.name} failed to load: ${err instanceof Error ? err.message : err}`);
    }
  }
}
