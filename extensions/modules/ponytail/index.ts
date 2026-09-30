// ponytail module — lazy-senior-dev mode for Pi.
//
// Ported from pi-ponytail extensions/index.js (ESM JS → TS). Registers the
// /ponytail mode switcher + /ponytail-* skill aliases, the status-bar
// indicator, per-turn system-prompt injection, and subagent instruction
// inheritance. Exports the pure helpers for tests.

import type {
  BeforeAgentStartEventResult,
  CustomToolCallEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MODE,
  RUNTIME_MODES,
  VALID_MODES,
  getDefaultMode,
  getHideStatus,
  getQuietStartup,
  isDeactivationCommand,
  normalizeMode,
  normalizePersistedMode,
  writeConfigBools,
  writeDefaultMode,
  type PonytailMode,
} from "./lib/config.js";
import { row, type PanelGroup } from "../../lib/panel.js";
import type { ModuleConfig } from "../../lib/registry.js";
import { filterSkillBodyForMode, getPonytailInstructions } from "./lib/instructions.js";
import { getSubagentInstructions, shouldInjectSubagentInstructions } from "./lib/subagent.js";

// ponytail: must match pi-subagent security.ts MAX_INSTRUCTIONS_LENGTH (instructions cap).
const SUBAGENT_INSTRUCTIONS_CAP = 16 * 1024;

export { filterSkillBodyForMode };
export const readDefaultMode = getDefaultMode;
export const readQuietStartup = getQuietStartup;

/** A persisted ponytail-mode session entry (written via pi.appendEntry). */
interface PonytailModeEntry {
  type: string;
  customType?: string;
  data?: { mode?: unknown };
}

export function resolveSessionMode(entries: unknown, fallbackMode: string = DEFAULT_MODE): PonytailMode {
  const fallback = normalizePersistedMode(fallbackMode) || DEFAULT_MODE;
  if (!Array.isArray(entries)) return fallback;

  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i] as PonytailModeEntry | undefined;
    if (entry?.type !== "custom" || entry?.customType !== "ponytail-mode") continue;

    const mode = normalizePersistedMode(entry?.data?.mode);
    if (mode) return mode;
  }

  return fallback;
}

interface ParsedCommand {
  type: "status" | "set-mode" | "invalid";
  mode?: string;
  reason?: "invalid-mode";
}

export function parsePonytailCommand(text: unknown): ParsedCommand {
  const normalizedText = String(text || "").trim().toLowerCase();

  if (!normalizedText) {
    // ponytail: bare invocation reports status instead of resetting (#99); explicit mode to change level.
    return { type: "status" };
  }

  const primary = normalizedText.split(/\s+/)[0];

  if (primary === "status") return { type: "status" };

  const mode = normalizePersistedMode(primary);
  return mode ? { type: "set-mode", mode } : { type: "invalid", reason: "invalid-mode", mode: primary };
}

export { writeDefaultMode };

export interface PonytailSettings {
  defaultMode: string;
  quietStartup: boolean;
  hideStatus: boolean;
}

/** Build the ponytail panel groups over a working copy (mutated by row
 *  setters). Exported for tests. */
export function buildPonytailGroups(cfg: PonytailSettings): PanelGroup[] {
  return [
    {
      key: "ponytail",
      label: "Ponytail",
      tab: "Tasks",
      icon: "🦥",
      rows: [
        row("ponytail.defaultMode", "Default mode", "string", cfg.defaultMode, (v) => {
          cfg.defaultMode = String(v ?? "").trim();
        }, {
          values: RUNTIME_MODES,
          defaultValue: DEFAULT_MODE,
          description: "Ponytail intensity for new sessions (review is session-only, not a default). PONYTAIL_DEFAULT_MODE env overrides the saved value.",
        }),
        row("ponytail.quietStartup", "Quiet startup", "toggle", cfg.quietStartup, (v) => {
          cfg.quietStartup = Boolean(v);
        }, {
          description: "Skip the startup mode banner. PONYTAIL_QUIET_STARTUP env overrides the saved value.",
          defaultValue: false,
        }),
        row("ponytail.hideStatus", "Hide status bar", "toggle", cfg.hideStatus, (v) => {
          cfg.hideStatus = Boolean(v);
        }, {
          description: "Hide the status-bar mode segment. PONYTAIL_HIDE_STATUS env overrides the saved value.",
          defaultValue: false,
        }),
      ],
    },
  ];
}

const OWNED_KEYS = ["ponytail.defaultMode", "ponytail.quietStartup", "ponytail.hideStatus"];

/** Ponytail's ModuleConfig for the central /config panel. Row descriptions +
 *  warnings disclose env precedence and next-session timing; the save notify
 *  stays a short confirmation (plus an env caveat when it actually bit). */
export function ponytailConfig(): ModuleConfig {
  const before: PonytailSettings = {
    defaultMode: getDefaultMode(),
    quietStartup: getQuietStartup(),
    hideStatus: getHideStatus(),
  };
  const working = structuredClone(before);
  return {
    groups: () => buildPonytailGroups(working),
    save: async (edited, ctx) => {
      if (!OWNED_KEYS.some((k) => edited.has(k))) return;

      // Bools first: they're independent of the mode's validity.
      if (working.quietStartup !== before.quietStartup || working.hideStatus !== before.hideStatus) {
        writeConfigBools({
          quietStartup: working.quietStartup !== before.quietStartup ? working.quietStartup : undefined,
          hideStatus: working.hideStatus !== before.hideStatus ? working.hideStatus : undefined,
        });
      }

      let modeNote = "";
      if (working.defaultMode !== before.defaultMode) {
        const mode = normalizeMode(working.defaultMode);
        if (!mode) {
          ctx.ui.notify(`Invalid ponytail default mode “${working.defaultMode}”. Use: ${RUNTIME_MODES.join(", ")}.`, "warning");
        } else {
          writeDefaultMode(mode);
          // Report the EFFECTIVE default — PONYTAIL_DEFAULT_MODE env wins.
          const effective = getDefaultMode();
          if (effective !== mode) {
            modeNote = ` PONYTAIL_DEFAULT_MODE env keeps the default at ${effective}.`;
          }
        }
      }

      // Row descriptions already disclose env precedence; the notify adds the
      // caveat only when an env var actually shadowed this save.
      const envBooleans = process.env.PONYTAIL_HIDE_STATUS || process.env.PONYTAIL_QUIET_STARTUP;
      ctx.ui.notify(
        `Ponytail config saved.${modeNote}` +
          (envBooleans ? " PONYTAIL_* env vars override the saved booleans." : "") +
          " Applied from the next session (or /reload).",
        modeNote || envBooleans ? "warning" : "info",
      );
    },
  };
}

export default function ponytailExtension(pi: ExtensionAPI) {
  // Skills ship in-package (../skills/, 3 levels up from the module dir) and are
  // contributed through resources_discover — NOT via the package.json `pi.skills`
  // manifest — so the kill-switch gates them too: disabled module ⇒ factory never
  // runs ⇒ no /skill:ponytail* entries registered.
  pi.on("resources_discover", () => ({ skillPaths: [new URL("../../../skills/", import.meta.url).pathname] }));

  let currentMode: PonytailMode = DEFAULT_MODE;
  let configuredDefaultMode: PonytailMode = getDefaultMode();
  let hideStatus = getHideStatus();

  // -- Status bar --
  function syncStatus(ctx: ExtensionContext | undefined | null) {
    if (hideStatus) return;
    if (!ctx?.ui?.setStatus) return;
    // ponytail: try/catch guards against pi-web theme proxy throwing before initTheme (#336).
    let theme: ExtensionContext["ui"]["theme"] | undefined;
    try {
      theme = ctx.ui.theme;
      if (!theme?.fg) return;
    } catch {
      return;
    }
    if (currentMode === "off") {
      try {
        ctx.ui.setStatus("ponytail", "");
      } catch {
        return;
      }
      return;
    }
    {
      const levelIcons: Record<string, string> = { lite: "🌿", full: "⚡", ultra: "🔥", review: "🔍" };
      const icon = levelIcons[currentMode] || "";
      const label = currentMode.toUpperCase();
      try {
        ctx.ui.setStatus("ponytail", " 🐴 " + theme.fg("muted", "ponytail: ") + theme.fg("text", icon + " " + label));
      } catch {
        return;
      }
    }
  }

  const setMode = (mode: string, ctx?: ExtensionContext | null) => {
    const normalized = normalizePersistedMode(mode);
    if (!normalized) return;
    // ponytail: 'review' is session-only — it updates the live session but must
    // not ride the persisted-entry channel (a reload can't resurrect it).
    if (normalized !== "review") pi.appendEntry("ponytail-mode", { mode: normalized });
    currentMode = normalized;
    syncStatus(ctx);
  };

  pi.registerCommand("ponytail", {
    description: `Set mode: ${VALID_MODES.join("|")} (review is session-only), or status`,
    getArgumentCompletions: (prefix) => {
      const q = String(prefix || "").trim().toLowerCase();
      const vocab = [...VALID_MODES, "status"];
      const items = vocab.filter((k) => k.startsWith(q)).map((k) => ({ value: k, label: k }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const parsed = parsePonytailCommand(args);

      if (parsed.type === "status") {
        ctx?.ui?.notify?.(`Ponytail: current ${currentMode} • default ${configuredDefaultMode} • /ponytail <mode> to change`, "info");
        return;
      }

      if (parsed.type === "set-mode") {
        setMode(parsed.mode!, ctx);
        return;
      }

      if (parsed.type === "invalid") {
        const msg = `Unknown mode: ${parsed.mode}. Use: lite, full, ultra, off, or status.`;
        ctx?.ui?.notify?.(msg, "warning");
        return;
      }
    },
  });

  for (const name of ["review", "audit", "gain", "debt", "help"] as const) {
    pi.registerCommand(`ponytail-${name}`, {
      description: `Run /skill:ponytail-${name}`,
      handler: async () => {
        await pi.sendUserMessage(`/skill:ponytail-${name}`, { expandPromptTemplates: true });
      },
    });
  }

  pi.on("input", async (event, ctx) => {
    if (event?.source === "extension") return;

    const text = String(event?.text || "");
    if (currentMode !== "off" && isDeactivationCommand(text)) {
      setMode("off", ctx);
    }
  });

  pi.on("agent_start", async (_event, ctx) => {
    syncStatus(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    syncStatus(ctx);
  });

  pi.on("session_start", async (_event, ctx) => {
    const sessionManager = ctx?.sessionManager;
    const entries: SessionEntry[] =
      (typeof sessionManager?.getBranch === "function" ? sessionManager.getBranch() : undefined) ??
      (typeof sessionManager?.getEntries === "function" ? sessionManager.getEntries() : []) ??
      [];
    configuredDefaultMode = getDefaultMode();
    hideStatus = getHideStatus();
    currentMode = resolveSessionMode(entries, configuredDefaultMode);
    syncStatus(ctx);
    if (!getQuietStartup()) {
      ctx?.ui?.notify?.(`Ponytail loaded: ${currentMode}`, "info");
    }
  });

  pi.on("before_agent_start", async (event): Promise<BeforeAgentStartEventResult | undefined> => {
    if (!currentMode || currentMode === "off") return;
    // ponytail: suppress only a *leading* marker — the real prior-injection shapes
    // (injected prompt leads with the block; an inherited Task Contract leads with
    // it after "## Task Contract\n"). An incidental mid-text mention must not
    // suppress injection, mirroring the tool_call side below.
    const basePrompt = typeof event?.systemPrompt === "string" ? event.systemPrompt : "";
    if (basePrompt.startsWith("PONYTAIL MODE ACTIVE") || basePrompt.includes("\n## Task Contract\nPONYTAIL MODE ACTIVE")) return;
    // Guard null/undefined event and missing systemPrompt (#439, #440).
    const base = event?.systemPrompt ? `${event.systemPrompt}\n\n` : "";
    return { systemPrompt: `${base}${getPonytailInstructions(currentMode)}` };
  });

  // ponytail: subagents run with loadExtensions:false, so the ruleset never reaches them (#254).
  // Prepend a compact block to the subagent tool's instructions; pi-subagent applies it to every child.
  pi.on("tool_call", async (event) => {
    if (event?.toolName !== "subagent") return;
    // ponytail: off and review skip injection; review defers to the /ponytail-review skill,
    // which lean (extension-less) children cannot load.
    if (!currentMode || currentMode === "off" || currentMode === "review") return;
    if (!shouldInjectSubagentInstructions()) return;
    const input = (event as CustomToolCallEvent).input;
    if (!input || typeof input !== "object") return;
    const existing = typeof input.instructions === "string" ? input.instructions : "";
    // ponytail: startsWith, not includes — an incidental mid-text mention must not suppress injection.
    if (existing.startsWith("PONYTAIL MODE ACTIVE")) return;
    const block = getSubagentInstructions(currentMode);
    const candidate = block + (existing ? "\n\n" + existing : "");
    // ponytail: pi-subagent slices instructions at SUBAGENT_INSTRUCTIONS_CAP; skip rather
    // than silently truncating the caller's contract to fit the injected block.
    if (candidate.length > SUBAGENT_INSTRUCTIONS_CAP) return;
    input.instructions = candidate;
  });
}
