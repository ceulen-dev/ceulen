// ux module — anti-slop UI/UX design discipline for Pi.
//
// Ported from @bacnh85/pi-ux 0.6.6 extensions/index.js (ESM JS → TS). Registers
// the /ux mode switcher, the ux_audit tool, per-turn system-prompt injection,
// and the 4 ux skills (resources_discover — kill-switch gated). Renders NO
// status-bar segment. Exports the pure helpers for tests.

import fs from "node:fs";
import path from "node:path";
import type {
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { audit } from "./lib/audit.js";
import {
  DEFAULT_MODE,
  RUNTIME_MODES,
  getDefaultMode,
  getQuietStartup,
  isDeactivationCommand,
  normalizeMode,
  writeConfigBools,
  writeDefaultMode,
  type UxMode,
} from "./lib/config.js";
import { getUxInstructions } from "./lib/instructions.js";
import { row, type PanelGroup } from "../../lib/panel.js";
import { skillsRoot } from "../../lib/skill-path.js";
import type { ModuleConfig } from "../../lib/registry.js";

export const readDefaultMode = getDefaultMode;
export const readQuietStartup = getQuietStartup;

/** A persisted ux-mode session entry (written via pi.appendEntry). */
interface UxModeEntry {
  type: string;
  customType?: string;
  data?: { mode?: unknown };
}

export function resolveSessionMode(entries: unknown, fallbackMode: string = DEFAULT_MODE): UxMode {
  const fallback = normalizeMode(fallbackMode) || DEFAULT_MODE;
  if (!Array.isArray(entries)) return fallback;

  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i] as UxModeEntry | undefined;
    if (entry?.type !== "custom" || entry?.customType !== "ux-mode") continue;

    const mode = normalizeMode(entry?.data?.mode);
    if (mode) return mode;
  }

  return fallback;
}

interface ParsedCommand {
  type: "status" | "set-mode" | "invalid";
  mode?: string;
  reason?: "invalid-mode";
}

export function parseUxCommand(text: unknown): ParsedCommand {
  const normalizedText = String(text || "").trim().toLowerCase();

  if (!normalizedText) {
    // ponytail: bare invocation reports status instead of resetting (#99, same
    // as ceulen's ponytail) — explicit mode to change level.
    return { type: "status" };
  }

  const primary = normalizedText.split(/\s+/)[0];

  if (primary === "status") return { type: "status" };

  const mode = normalizeMode(primary);
  return mode ? { type: "set-mode", mode } : { type: "invalid", reason: "invalid-mode", mode: primary };
}

export { writeDefaultMode };

// ponytail: plain JSON-schema object, not TypeBox — at runtime the symbols are
// stripped on JSON.stringify anyway, and we keep zero deps. Shape matches what
// Type.Object produces for the LLM tool spec.
function auditParametersSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      path: {
        type: "string",
        description: "Path to a CSS stylesheet file to audit verbatim (absolute or cwd-relative). PREFERRED over retyping `css` — retyped copies drift (inlined tokens, mislabeled pairs) and cause false audit failures. Exactly one of path/css.",
      },
      css: {
        type: "string",
        description: "CSS stylesheet content to audit (inline stylesheets, styled-components output, or a concatenated .css file). Prefer `path` for on-disk files. Exactly one of path/css.",
      },
      pairs: {
        type: "array",
        description: "Foreground/background colour pairs to check for contrast (APCA primary + WCAG sidecar). fg + bg as #hex or oklch(); optional weight/size set the APCA threshold; min is the WCAG compliance floor.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            fg: { type: "string", description: "Foreground colour, e.g. '#111111' or 'oklch(60% 0.18 250)'." },
            bg: { type: "string", description: "Background colour, e.g. '#ffffff'." },
            label: { type: "string", description: "Human label for this text style (e.g. 'body')." },
            min: { type: "number", description: "WCAG compliance floor (4.5 body, 3.0 large/UI). Shown as a sidecar; the primary gate is APCA. Defaults to 4.5. Pairs with min 3 and NO size/weight are treated as non-text graphics (APCA Lc 30 per the gate table)." },
            weight: { type: "number", description: "Font weight (400/500/700). With size, sets the APCA threshold. Defaults to 400." },
            size: { type: "number", description: "Font size in px. With weight, sets the APCA threshold. Defaults to 16." },
          },
          required: ["fg", "bg"],
        },
      },
    },
  };
}

/**
 * Resolve the stylesheet to audit: a file `path` read verbatim (preferred —
 * retyped `css` drifts and causes false gate failures) or inline `css`.
 * Exactly one of the two. Files are capped (~1MB via statSync before reading)
 * so a runaway stylesheet can't flood the model's context.
 */
const MAX_CSS_BYTES = 1024 * 1024;

export function resolveAuditCss(params: unknown, cwd?: string): string {
  const p = params as { css?: unknown; path?: unknown } | null | undefined;
  const css = typeof p?.css === "string" ? p.css : "";
  const hasCss = css.trim().length > 0;
  const fileArg = typeof p?.path === "string" ? p.path.trim() : "";
  if (hasCss && fileArg) throw new Error("Pass exactly one of `path` or `css` — not both.");
  if (!hasCss && !fileArg) throw new Error("Pass a stylesheet to audit: `path` (preferred, read verbatim) or `css`.");
  // Relative paths resolve against the tool-call cwd (falls back to the
  // process cwd) — the session cwd can differ from this process's cwd.
  if (fileArg) {
    const file = path.resolve(cwd || process.cwd(), fileArg);
    if (fs.statSync(file).size > MAX_CSS_BYTES) {
      throw new Error(`Stylesheet is over the 1MB audit cap — audit a smaller file or split the stylesheet.`);
    }
    return fs.readFileSync(file, "utf8");
  }
  return css;
}

export function formatAuditResult(result: ReturnType<typeof audit>): string {
  const lines = [];
  lines.push(result.pass ? "✅ UX AUDIT PASSED" : "❌ UX AUDIT FAILED");
  lines.push("");

  const c = result.gates.contrast;
  lines.push(c.pass ? "✓ Contrast (APCA)" : "✗ Contrast (APCA)");
  for (const r of c.results) {
    const lc = r.apca === null ? "n/a" : `Lc ${r.apca}`;
    const ratio = r.ratio === null ? "n/a" : `${r.ratio.toFixed(2)}:1`;
    lines.push(`  ${r.pass ? "✓" : "✗"} ${r.label || `${r.fg}/${r.bg}`}: ${lc} (min Lc ${r.apcaMin}) · WCAG ${ratio} (min ${r.min ?? 4.5})`);
  }

  const t = result.gates.tokens;
  lines.push(t.pass ? "✓ Tokens" : "✗ Tokens");
  for (const h of t.hardcodedHex) lines.push(`  ✗ hardcoded hex: ${h}`);
  for (const s of t.adhocShadow) lines.push(`  ✗ ad-hoc box-shadow: ${s}`);

  const s = result.gates.states;
  lines.push(s.pass ? "✓ States" : "✗ States");
  for (const m of s.missingFocusVisible) lines.push(`  ✗ ${m}`);
  for (const m of s.missingDisabled) lines.push(`  ✗ ${m}`);
  for (const m of s.missingReducedMotion || []) lines.push(`  ✗ ${m}`);
  if (!s.pass) {
    if (s.missingFocusVisible.length || s.missingDisabled.length) {
      // Interactive selectors ARE present, yet focus/disabled rules failed —
      // for a fragment those rules may simply live in another file.
      lines.push("  ℹ If this is a fragment, states rules may live in another file — pass the COMPLETE stylesheet.");
    } else if (s.hasInteractive === false) {
      // No interactive selectors: the only possible failure is reduced-motion.
      // Say how to fix it, and only conditionally suggest the fragment case.
      lines.push("  ℹ Motion needs a prefers-reduced-motion fallback. If this is the complete stylesheet, add one; if it is a fragment, audit the COMPLETE stylesheet.");
    }
  }

  const st = result.gates.slopTells;
  lines.push(st.pass ? "✓ Slop tells" : "✗ Slop tells");
  for (const tell of st.tells) lines.push(`  ✗ ${tell}`);

  return lines.join("\n");
}

export interface UxSettings {
  defaultMode: string;
  quietStartup: boolean;
}

/** Build the ux panel groups over a working copy (mutated by row setters).
 *  Exported for tests. */
export function buildUxGroups(cfg: UxSettings): PanelGroup[] {
  return [
    {
      key: "ux",
      label: "UX discipline",
      tab: "Appearance",
      icon: "📐",
      rows: [
        row("ux.defaultMode", "Default mode", "string", cfg.defaultMode, (v) => {
          cfg.defaultMode = String(v ?? "").trim();
        }, {
          values: RUNTIME_MODES,
          defaultValue: DEFAULT_MODE,
          description: "UX discipline for new sessions (lite = guardrail only, strict = audit gate blocks handoff). PI_UX_DEFAULT_MODE env overrides the saved value.",
        }),
        row("ux.quietStartup", "Quiet startup", "toggle", cfg.quietStartup, (v) => {
          cfg.quietStartup = Boolean(v);
        }, {
          description: "Skip the startup mode notice. PI_UX_QUIET_STARTUP env overrides the saved value.",
          defaultValue: false,
        }),
      ],
    },
  ];
}

const OWNED_KEYS = ["ux.defaultMode", "ux.quietStartup"];

/** ux's ModuleConfig for the central /config panel. Row descriptions disclose
 *  env precedence + next-session timing; the save notify stays a short
 *  confirmation (plus an env caveat when it actually bit). */
export function uxConfig(): ModuleConfig {
  const before: UxSettings = {
    defaultMode: getDefaultMode(),
    quietStartup: getQuietStartup(),
  };
  const working = structuredClone(before);
  return {
    groups: () => buildUxGroups(working),
    save: async (edited, ctx) => {
      if (!OWNED_KEYS.some((k) => edited.has(k))) return;

      if (working.quietStartup !== before.quietStartup) {
        writeConfigBools({ quietStartup: working.quietStartup });
      }

      let modeNote = "";
      if (working.defaultMode !== before.defaultMode) {
        const mode = normalizeMode(working.defaultMode);
        if (!mode) {
          ctx.ui.notify(`Invalid ux default mode “${working.defaultMode}”. Use: ${RUNTIME_MODES.join(", ")}.`, "warning");
        } else {
          writeDefaultMode(mode);
          // Report the EFFECTIVE default — PI_UX_DEFAULT_MODE env wins.
          const effective = getDefaultMode();
          if (effective !== mode) {
            modeNote = ` PI_UX_DEFAULT_MODE env keeps the default at ${effective}.`;
          }
        }
      }

      // Row descriptions already disclose env precedence; the notify adds the
      // caveat only when an env var actually shadowed this save.
      const envBooleans = process.env.PI_UX_QUIET_STARTUP;
      ctx.ui.notify(
        `UX config saved.${modeNote}` +
          (envBooleans ? " PI_UX_* env vars override the saved booleans." : "") +
          " Applied from the next session (or /reload).",
        modeNote || envBooleans ? "warning" : "info",
      );
    },
  };
}

// ponytail: the harness stubs in test/ are untyped by design, so the audit
// tool is declared with the public ToolDefinition shape over loose params.
type AuditToolDefinition = ToolDefinition<never, ReturnType<typeof audit> | undefined>;

export default function uxExtension(pi: ExtensionAPI) {
  // Skills ship in-package (../../../skills/ux-*/, 3 levels up from the module
  // dir) and are contributed through resources_discover — NOT via the
  // package.json `pi.skills` manifest — so the kill-switch gates them too:
  // disabled module ⇒ factory never runs ⇒ no ux-* skills registered. Only
  // THIS module's dirs: the shared skills/ root belongs to ponytail's handler.
  pi.on("resources_discover", () => ({
    skillPaths: ["ux-design", "ux-capture", "ux-presets", "ux-routing"].map((n) => path.join(skillsRoot(), n)),
  }));

  let currentMode: UxMode = DEFAULT_MODE;
  let configuredDefaultMode: UxMode = getDefaultMode();

  const setMode = (mode: string, ctx?: ExtensionContext | null) => {
    const normalized = normalizeMode(mode);
    if (!normalized) return;
    pi.appendEntry("ux-mode", { mode: normalized });
    currentMode = normalized;
  };

  const auditTool: AuditToolDefinition = {
    name: "ux_audit",
    label: "UX Slop Audit",
    description:
      "Run deterministic slop-audit gates on CSS: APCA contrast (perceptual; WCAG sidecar), off-system token values (hardcoded hex / ad-hoc shadows), missing interaction states (:focus-visible / :disabled + prefers-reduced-motion), and named AI slop tells (glassmorphism, gradient orbs, neon glow, default-card, tracked-out eyebrows, tinted near-black). No model needed — all gates are computable. In strict mode, handoff is blocked until this passes. AUDIT THE COMPLETE STYLESHEET, not fragments. If no contrast pairs are supplied, they are auto-extracted from rules that declare both colour and background.",
    promptSnippet: "Run deterministic UX slop-audit (APCA contrast + tokens + states + slop tells)",
    promptGuidelines: [
      "Pass `path` to the stylesheet file — it is audited verbatim. NEVER retype or condense CSS into the `css` string when the file is on disk: retyped copies drift (inlined DESIGN.md shadow values, mislabeled pairs) and produce false failures or false confidence.",
      "Contrast, token-coverage, and slop-tells are computable, not judgement — use this tool instead of eyeballing or calling a vision model.",
      "Pass fg/bg colour pairs (hex or oklch()) + optional weight/size to set the APCA threshold; the WCAG ratio is shown as a compliance sidecar. Omit pairs and they are auto-extracted from colour+background rules — but hand-picking catches text-on-inherited-backgrounds that auto-extraction misses.",
      "Audit the COMPLETE stylesheet — fragment input falsely fails the States gate (no interactive selectors present) and misses off-system values elsewhere.",
      "Pass the CSS string to scan for hardcoded hex, ad-hoc box-shadow, and named AI tells (glassmorphism, gradient orbs, neon glow, the shadcn default-card reflex, 1px gray borders, tracked-out eyebrows, tinted near-black). Transition/animation CSS must ship a prefers-reduced-motion fallback.",
      "State coverage flags interactive elements (button/a/input/...) missing :focus-visible or :disabled rules.",
    ],
    parameters: auditParametersSchema() as AuditToolDefinition["parameters"],
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      let css: string;
      try {
        css = resolveAuditCss(params, ctx?.cwd);
      } catch (e) {
        return {
          content: [{ type: "text", text: `❌ UX AUDIT ERROR: ${e instanceof Error ? e.message : e}` }],
          details: undefined,
          isError: true,
        };
      }
      const raw = params as unknown as { pairs?: unknown } | null;
      const pairs = Array.isArray(raw?.pairs) ? (raw.pairs as never) : [];
      const result = audit({ css, pairs });
      return {
        content: [{ type: "text", text: formatAuditResult(result) }],
        details: result,
      };
    },
  };
  pi.registerTool(auditTool);

  pi.registerCommand("ux", {
    description: `Set mode: ${RUNTIME_MODES.join("|")}, or status`,
    getArgumentCompletions: (prefix) => {
      const q = String(prefix || "").trim().toLowerCase();
      const vocab = [...RUNTIME_MODES, "status"];
      const items = vocab.filter((k) => k.startsWith(q)).map((k) => ({ value: k, label: k }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const parsed = parseUxCommand(args);

      if (parsed.type === "status") {
        ctx?.ui?.notify?.(`UX: current ${currentMode} • default ${configuredDefaultMode} • /ux <mode> to change`, "info");
        return;
      }

      if (parsed.type === "set-mode") {
        setMode(parsed.mode!, ctx);
        ctx?.ui?.notify?.(`UX discipline: ${parsed.mode}`, "info");
        return;
      }

      if (parsed.type === "invalid") {
        ctx?.ui?.notify?.(`Unknown mode: ${parsed.mode}. Use: lite, strict, off, or status.`, "warning");
        return;
      }
    },
  });

  pi.on("input", async (event, ctx) => {
    if (event?.source === "extension") return;

    const text = String(event?.text || "");
    if (currentMode !== "off" && isDeactivationCommand(text)) {
      setMode("off", ctx);
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    const sessionManager = ctx?.sessionManager;
    const entries: SessionEntry[] =
      (typeof sessionManager?.getBranch === "function" ? sessionManager.getBranch() : undefined) ??
      (typeof sessionManager?.getEntries === "function" ? sessionManager.getEntries() : []) ??
      [];
    configuredDefaultMode = getDefaultMode();
    currentMode = resolveSessionMode(entries, configuredDefaultMode);
    if (!getQuietStartup()) {
      ctx?.ui?.notify?.(`UX discipline loaded: ${currentMode}`, "info");
    }
  });

  pi.on("before_agent_start", async (event): Promise<BeforeAgentStartEventResult | undefined> => {
    if (!currentMode || currentMode === "off") return;
    // Guard null/undefined event and missing systemPrompt.
    const base = event?.systemPrompt ? `${event.systemPrompt}\n\n` : "";
    return { systemPrompt: `${base}${getUxInstructions(currentMode)}` };
  });
}
