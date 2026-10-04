/**
 * Router's contribution to the central /config panel: ONE build + save path
 * (the save must re-register the provider and force a catalog refresh —
 * duplicating it would drift).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isProjectTrusted, type ModuleConfig } from "../../lib/registry.js";
import { row, type PanelGroup } from "../../lib/panel.js";
import { getSettings, writeRouterSection, type RouterSettings } from "./lib/config.js";
import { registerProvider, maybeRefreshCatalog } from "./lib/provider.js";
import { refreshActiveModel } from "./lib/refresh.js";

/** Read the panel's working copy: the EFFECTIVE values (env/project overrides
 *  shown), so the panel never hides what the next request will actually use.
 *  `trusted` is required — the caller decides, mirroring the rule the save-time
 *  ctx applies (see zai's precedent). */
export function readRouterSettings(trusted: boolean): RouterSettings {
  return getSettings({ trustProject: trusted });
}

/** Build the router panel groups over a working copy (mutated by row setters).
 *  ONE group — the OMP "Providers" tab carries a single "Router" section
 *  (its Enable kill-switch row is prepended by the config module). Exported
 *  for tests. */
export function buildRouterGroups(cfg: RouterSettings): PanelGroup[] {
  return [
    {
      key: "router",
      label: "Router",
      tab: "Providers",
      icon: "🌐",
      rows: [
        row("router.baseUrl", "Base URL", "string", cfg.baseUrl, (v) => {
          cfg.baseUrl = String(v ?? "").trim();
        }, {
          description: "Yardmaster/OmniRoute OpenAI-compatible endpoint (e.g. http://host:20128/v1). ROUTER_BASE_URL env (or a trusted repo's .pi/settings.json) overrides the saved value.",
          defaultValue: "",
        }),
        row("router.enableReasoning", "Thinking levels", "toggle", cfg.enableReasoning, (v) => {
          cfg.enableReasoning = Boolean(v);
        }, {
          description: "Expose Pi thinking-level controls on router models. ROUTER_ENABLE_REASONING env overrides the saved value.",
          defaultValue: true,
        }),
      ],
    },
  ];
}

/** Persist the working copy + apply it live: re-register the provider from the
 *  EFFECTIVE settings (so a trusted repo's `router.baseUrl` is what the next
 *  request and the forced catalog refresh actually use — re-registering the raw
 *  saved copy would redirect the endpoint while `ROUTER_BASE_URL` set), force a
 *  catalog refresh (new endpoint or reasoning flag must take effect immediately
 *  — bypass TTL, supersede any in-flight fetch), then keep the active model
 *  valid. Notifies effective vs saved values (env/repo precedence can shadow
 *  the persisted ones) — one save path, no drift. */
export async function saveRouterConfig(pi: ExtensionAPI, before: RouterSettings, working: RouterSettings, ctx: ExtensionContext): Promise<void> {
  if (working.baseUrl === before.baseUrl && working.enableReasoning === before.enableReasoning) {
    ctx.ui.notify("No changes.", "info");
    return;
  }
  writeRouterSection({
    baseUrl: working.baseUrl !== before.baseUrl ? working.baseUrl : undefined,
    enableReasoning: working.enableReasoning !== before.enableReasoning ? working.enableReasoning : undefined,
  });
  const trusted = ctx.isProjectTrusted?.() === true;
  const effective = readRouterSettings(trusted);
  registerProvider(pi, effective);
  try {
    await maybeRefreshCatalog(ctx, { force: true });
  } catch { /* refresh errors are surfaced by Pi elsewhere */ }
  await refreshActiveModel(pi, ctx);
  const overridden =
    (working.baseUrl !== effective.baseUrl && working.baseUrl !== "") ||
    working.enableReasoning !== effective.enableReasoning;
  ctx.ui.notify(
    overridden
      ? `Router: saved, but ROUTER_BASE_URL/ROUTER_ENABLE_REASONING env or repo .pi/settings.json overrides it — ` +
          `effective: ${effective.baseUrl || "(none)"}, reasoning ${effective.enableReasoning}.`
      : `Router config saved. Endpoint: ${effective.baseUrl || "(not configured)"} · reasoning ${effective.enableReasoning ? "ON" : "OFF"}`,
    overridden ? "warning" : "info",
  );
}

const OWNED_KEYS = ["router.baseUrl", "router.enableReasoning"];

/** Router's ModuleConfig for the central /config panel. */
export function routerConfig(pi: ExtensionAPI): ModuleConfig {
  // Baseline = what the next request resolves: the factory gets no ctx, so the
  // shared trust helper decides (same rule save-time ctx.isProjectTrusted
  // applies) — an untrusted checkout must not show phantom project values.
  const before = readRouterSettings(isProjectTrusted(process.cwd()));
  const working = structuredClone(before);
  return {
    groups: () => buildRouterGroups(working),
    save: async (edited, ctx) => {
      if (!OWNED_KEYS.some((k) => edited.has(k))) return;
      await saveRouterConfig(pi, before, working, ctx);
    },
  };
}
