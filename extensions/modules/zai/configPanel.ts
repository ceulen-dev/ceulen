/**
 * zai's contribution to the central /config panel (Providers tab, its own
 * section — the Enable kill-switch row is prepended by the config module).
 *
 * Every row is read PER REQUEST by the module, so only `zai.baseUrl` needs a
 * live re-register on save; speed/signing/throttle take effect on the next
 * request. Saving writes the GLOBAL agent-dir settings.json `zai` section —
 * a trusted project file (or env) can shadow it, and the save says so.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModuleConfig } from "../../lib/registry.js";
import { row, type PanelGroup } from "../../lib/panel.js";
import { DEFAULT_BASE_URL, KNOWN_BASE_URLS } from "./lib/anthropic.js";
import { DEFAULT_MIN_INTERVAL_MS } from "./lib/throttle.js";
import {
  getZaiSettings,
  globalSettingsPath,
  projectSettingsPath,
  readZaiSection,
  writeZaiSection,
  type ZaiSettings,
} from "./lib/settings.js";
import { registerZai, zaiRegisteredBaseUrl } from "./index.js";

/** Human labels for the known endpoints (the menu shows the URL itself). */
const BASE_URL_DESCRIPTIONS: Record<string, string> = {
  [DEFAULT_BASE_URL]: "Z.ai Coding Plan (default) — what ZCode's coding-plan route uses.",
  "https://open.bigmodel.cn/api/anthropic": "BigModel (China) Coding Plan.",
  "https://zcode.z.ai/api/v1/zcode-plan/anthropic": "ZCode Start Plan (JWT credential).",
  "https://zcode.z.ai/api/v1/ultra-zai/anthropic": "ZCode ultra route (coding-plan, V4-signed requests).",
};

/** Read the panel's working copy: the EFFECTIVE values (env/project overrides
 *  shown), so the panel never hides what the next request will actually use. */
export function readZaiSettings(cwd = process.cwd(), trusted = true): ZaiSettings {
  const s = getZaiSettings({ cwd, trusted });
  return { baseUrl: s.baseUrl, speed: s.speed, signing: s.signing, minIntervalMs: s.minIntervalMs };
}

/** Build the zai panel groups over a working copy (mutated by row setters).
 *  Exported for tests. */
export function buildZaiGroups(cfg: ZaiSettings): PanelGroup[] {
  return [
    {
      key: "zai",
      label: "Z.AI Coding Plan",
      tab: "Providers",
      icon: "🧠",
      rows: [
        row("zai.baseUrl", "Base URL", "string", cfg.baseUrl, (v) => {
          cfg.baseUrl = String(v ?? "").trim();
        }, {
          menu: () =>
            KNOWN_BASE_URLS.map((url) => ({
              value: url,
              label: url,
              description: BASE_URL_DESCRIPTIONS[url],
            })),
          defaultValue: DEFAULT_BASE_URL,
          description: "Anthropic-compatible endpoint for the GLM coding plan (provider zai-anthropic). ZAI_ANTHROPIC_BASE_URL env overrides the saved value.",
        }),
        row("zai.speed", "Speed tier", "string", cfg.speed, (v) => {
          cfg.speed = v === "standard" ? "standard" : "fast";
        }, {
          values: ["fast", "standard"],
          defaultValue: "fast",
          description: "ZCode-parity fast tier: adds `speed:\"fast\"` to the body plus the fast-mode beta header. Env ZAI_ANTHROPIC_SPEED overrides.",
        }),
        row("zai.signing", "ZCode request signing", "toggle", cfg.signing, (v) => {
          cfg.signing = Boolean(v);
        }, {
          defaultValue: true,
          warning: "First signed request performs a handshake with api.z.ai; fails open to unsigned. Env ZAI_ANTHROPIC_SIGNING=0 forces off.",
          description: "Sign requests like the ZCode desktop client (identity headers + Ed25519 signature + proof-of-work), server-gated and safe to leave on.",
        }),
        row("zai.minIntervalMs", "Dispatch spacing (ms)", "number", cfg.minIntervalMs, (v) => {
          cfg.minIntervalMs = Math.max(0, Math.floor(Number(v) || 0));
        }, {
          defaultValue: DEFAULT_MIN_INTERVAL_MS,
          description: "Minimum gap between request starts, shared across every pi process on this machine (Z.ai's 1302 request-rate limit). 0 disables the gate.",
        }),
      ],
    },
  ];
}

const OWNED_KEYS = ["zai.baseUrl", "zai.speed", "zai.signing", "zai.minIntervalMs"];

/** Persist the changed fields to the GLOBAL settings.json and live-apply the
 *  one field that is baked into the provider (baseUrl). Notifies which layer
 *  shadows the saved values (env > trusted project file > global). */
export async function saveZaiConfig(
  pi: ExtensionAPI,
  before: ZaiSettings,
  working: ZaiSettings,
  ctx: ExtensionContext,
): Promise<void> {
  if (OWNED_KEYS.every((k) => !changed(before, working, k))) {
    ctx.ui.notify("No changes.", "info");
    return;
  }
  const target = globalSettingsPath();
  writeZaiSection(
    {
      baseUrl: changed(before, working, "zai.baseUrl") ? working.baseUrl : undefined,
      speed: changed(before, working, "zai.speed") ? working.speed : undefined,
      signing: changed(before, working, "zai.signing") ? working.signing : undefined,
      minIntervalMs: changed(before, working, "zai.minIntervalMs") ? working.minIntervalMs : undefined,
    },
    target,
  );

  const trusted = ctx.isProjectTrusted?.() === true;
  const effective = getZaiSettings({ cwd: ctx.cwd, trusted });
  if (effective.baseUrl !== zaiRegisteredBaseUrl()) registerZai(pi, effective.baseUrl);

  // Disclosure: anything the saved layer loses to env / a trusted project file.
  const shadowed: string[] = [];
  for (const key of ["baseUrl", "speed", "signing", "minIntervalMs"] as const) {
    const source = effective.sources[key];
    if (source === "env" || source === "project") shadowed.push(`${key} (${source === "env" ? "env" : "trusted project .pi/settings.json"})`);
  }

  const notes = [`Z.AI config saved to ${target}.`];
  if (effective.baseUrl !== working.baseUrl) notes.push(`Effective endpoint: ${effective.baseUrl}.`);
  if (shadowed.length > 0) notes.push(`Shadowed by ${shadowed.join(", ")} — those win per field.`);
  if (!trusted && readZaiSection(projectSettingsPath(ctx.cwd)) !== null) {
    notes.push("This project is NOT trusted — pi ignores its .pi/settings.json until you trust this repo.");
  }
  ctx.ui.notify(notes.join(" "), shadowed.length > 0 ? "warning" : "info");
}

/** Compare one owned key across the working copy and the pre-edit snapshot. */
function changed(before: ZaiSettings, working: ZaiSettings, key: string): boolean {
  const field = key.slice("zai.".length) as keyof ZaiSettings;
  return before[field] !== working[field];
}

/** zai's ModuleConfig for the central /config panel. */
export function zaiConfig(pi: ExtensionAPI): ModuleConfig {
  const before = readZaiSettings(process.cwd(), true);
  const working = structuredClone(before);
  return {
    groups: () => buildZaiGroups(working),
    save: async (edited, ctx) => {
      if (!OWNED_KEYS.some((k) => edited.has(k))) return;
      await saveZaiConfig(pi, before, working, ctx);
    },
  };
}
