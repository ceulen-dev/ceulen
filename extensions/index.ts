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
import { loadCwdEnvFilesIfTrusted, migrateSecretsFromSettings } from "./lib/env.js";
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

/** Inject `exposure: "deferred"` onto a module's listed tools at registration
 *  — the registry's `deferredTools` list is the single tier source. Returns pi
 *  unchanged when the module defers nothing. */
function withDeferred(pi: ExtensionAPI, names?: string[]): ExtensionAPI {
  if (!names?.length) return pi;
  const deferred = new Set(names);
  const registerTool = pi.registerTool.bind(pi);
  return {
    ...pi,
    registerTool: (tool: Parameters<typeof pi.registerTool>[0]) =>
      registerTool(deferred.has(tool.name) ? { ...tool, exposure: "deferred" as const } : tool),
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
      // Grouped by each module's registry category (OMP taxonomy) — same
      // order as the registry, which is the /config tab order too.
      const byCat = new Map<string, { active: string[]; off: string[] }>();
      for (const m of MODULES) {
        const g = byCat.get(m.category) ?? { active: [], off: [] };
        (disabled.has(m.name) ? g.off : g.active).push(m.name);
        byCat.set(m.category, g);
      }
      const lines: string[] = [];
      for (const [cat, g] of byCat) {
        lines.push(`${cat}: ${g.active.join(", ")}${g.off.length ? ` (disabled: ${g.off.join(", ")})` : ""}`);
      }
      const activeCount = MODULES.length - disabled.size;
      const core = MODULES.filter((m) => m.core).map((m) => m.name);
      const deferredCount = MODULES.reduce((n, m) => n + (m.deferredTools?.length ?? 0), 0);
      ctx.ui.notify(
        `Ceulen ${activeCount} module(s) active:\n  ${lines.join("\n  ")}` +
          (core.length ? `\nCore (always on): ${core.join(", ")}` : "") +
          (deferredCount
            ? `\n${deferredCount} tool(s) deferred — tool_search loads them on demand.`
            : "") +
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
    // One-time migration: secrets saved pre-fix sit in PLAINTEXT settings.json
    // — move them into <agentDir>/.env.local (0600) and scrub. Env was already
    // winning at read time, so effective values are unchanged.
    migrateSecretsFromSettings();
    // Discovery activation: pi only auto-activates tool_search for MCP
    // servers — extension-registered deferred tools get nothing. Ceulen owns
    // the activation (the /config Built-in tools section has no tool_search
    // row for exactly this reason): when the bundle has a deferred tier, the
    // discovery tool must be declared or the tier is unreachable by the model.
    if (MODULES.some((m) => m.deferredTools?.length)) {
      const all = new Set(pi.getAllTools().map((t) => t.name));
      if (all.has("tool_search")) {
        const active = pi.getActiveTools();
        if (!active.includes("tool_search")) pi.setActiveTools([...active, "tool_search"]);
      } else {
        console.warn("ceulen: tool_search is not registered — deferred tools are reachable only via codemode/ctx.executeTool");
      }
    }
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
    const g = guarded(withDeferred(pi, m.deferredTools), m.name, owner);
    if (m.config) configContribs.set(m.name, () => m.config!(g));
    try {
      m.load(g, deps);
    } catch (err) {
      console.error(`ceulen: module ${m.name} failed to load: ${err instanceof Error ? err.message : err}`);
    }
  }
}
