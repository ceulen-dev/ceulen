import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { configSummary, getSettings } from "../lib/config.js";
import { maybeRefreshCatalog, PROVIDER_ID } from "../lib/provider.js";

/** Router model ids from the last /router-model invocation — the completion
 *  hook has no ctx, so it replays this cache (empty until first use). */
let lastRouterModelIds: string[] | undefined;

export function registerCommands(pi: ExtensionAPI): void {
  pi.registerCommand("router-model", {
    description: "Search and select a router model by name.",
    getArgumentCompletions: (prefix) => {
      // Model list is cached by the last invocation (registry is not reachable
      // synchronously from the completion hook on first use).
      const ids = lastRouterModelIds ?? [];
      const q = (prefix || "").trim().toLowerCase();
      const items = ids
        .filter((id) => id.toLowerCase().includes(q))
        .map((id) => ({ value: id, label: id }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/router-model requires interactive (TUI) mode.", "error");
        return;
      }
      // Pull the live catalog first (TTL-gated, in-flight-guarded) — mirrors
      // Pi's own /model picker, which refreshes every time it opens. Best
      // effort: on failure the cached list still serves.
      try { await maybeRefreshCatalog(ctx); } catch { /* cached list below */ }
      const ids = ctx.modelRegistry
        .getAll()
        .filter((m) => m.provider === PROVIDER_ID)
        .map((m) => m.id);
      lastRouterModelIds = ids;
      if (ids.length === 0) {
        ctx.ui.notify("No router models available yet — open /models or /login router to trigger discovery.", "error");
        return;
      }

      const term = (args || "").trim().toLowerCase();
      const matches = term ? ids.filter((id) => id.toLowerCase().includes(term)) : ids;

      if (matches.length === 0) {
        ctx.ui.notify(`No router models matching "${args}".`, "error");
        return;
      }

      async function trySelect(id: string): Promise<boolean> {
        const model = ctx.modelRegistry.find(PROVIDER_ID, id);
        if (!model) return false;
        try { await pi.setModel(model); return true; }
        catch { return false; }
      }

      if (matches.length === 1) {
        const ok = await trySelect(matches[0]);
        ctx.ui.notify(
          ok ? `Selected ${PROVIDER_ID}/${matches[0]}` : `Failed to select ${PROVIDER_ID}/${matches[0]}`,
          ok ? "info" : "error",
        );
        return;
      }

      const choice = await ctx.ui.select("Select router model:", matches);
      if (choice) {
        const ok = await trySelect(choice);
        ctx.ui.notify(
          ok ? `Selected ${PROVIDER_ID}/${choice}` : `Failed to select ${PROVIDER_ID}/${choice}`,
          ok ? "info" : "error",
        );
      }
    },
  });

  pi.registerCommand("router-status", {
    description: "Show router connection status and model info.",
    handler: async (_args, ctx) => {
      const settings = getSettings();
      const count = ctx.modelRegistry
        .getAll()
        .filter((m) => m.provider === PROVIDER_ID).length;
      const classifiers = ctx.modelRegistry.getModelsOfType("classifier", PROVIDER_ID);
      const lines = [
        "── Router Status ──",
        configSummary(settings),
        `Models in catalog: ${count}`,
        classifiers.length > 0
          ? `Classifier models: ${classifiers.length} (${classifiers.map((m) => m.id).join(", ")})`
          : "Classifier models: 0",
        "",
        "Commands:",
        "  /login router       Store API key (auth.json)",
        "  /config             Central settings panel (all ceulen modules)",
        "  /router-model       Search and select a model",
        "  /model              Pi built-in picker (triggers refresh)",
        "",
        "URL: settings.json `router.baseUrl` or ROUTER_BASE_URL env.",
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
