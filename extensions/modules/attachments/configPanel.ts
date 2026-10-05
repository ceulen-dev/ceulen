/**
 * attachments' /config contribution — Files tab, Attachments section.
 *
 * Rows write the GLOBAL agent-dir settings.json `attachments` section
 * (lib/settings.ts — the same file the module re-reads on session_start, so a
 * save applies to the NEXT session without /reload; the paste-file shortcut
 * additionally binds at module load and needs a full restart).
 */
import { row, type PanelGroup } from "../../lib/panel.js";
import type { ModuleConfig } from "../../lib/registry.js";
import { DEFAULTS, loadSettings, writeAttachmentsSection, type AttachmentsSettings } from "./lib/settings.js";

/** Build the attachments panel groups over a working copy (mutated by row
 *  setters). Exported for tests. */
export function buildAttachmentsGroups(cfg: AttachmentsSettings): PanelGroup[] {
  return [
    {
      key: "attachments",
      label: "Attachments",
      tab: "Files",
      icon: "📎",
      rows: [
        row("attachments.inlineTextFiles", "Inline text files", "toggle", cfg.inlineTextFiles, (v) => {
          cfg.inlineTextFiles = Boolean(v);
        }, {
          description: "Inline text-file paths as <file> content blocks instead of 📎 path chips — convenient, but re-read on every turn.",
          defaultValue: DEFAULTS.inlineTextFiles,
        }),
        row("attachments.maxInlineBytes", "Max inline bytes", "number", cfg.maxInlineBytes, (v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n > 0) cfg.maxInlineBytes = n;
        }, {
          description: "Size cap for text-file inlining (inline mode only). Larger files keep the 📎 path chip.",
          defaultValue: DEFAULTS.maxInlineBytes,
        }),
        row("attachments.pasteFileShortcut", "Paste-file shortcut", "string", cfg.pasteFileShortcut, (v) => {
          const s = String(v ?? "").trim();
          if (s) cfg.pasteFileShortcut = s;
        }, {
          warning: "Takes effect after a full restart — the shortcut binds when the extension loads.",
          description: "Keybinding for paste-file-from-clipboard (pi-tui KeyId grammar, e.g. alt+shift+v, ctrl+shift+v, f2).",
          defaultValue: DEFAULTS.pasteFileShortcut,
        }),
        row("attachments.pasteCollapseLines", "Paste collapse lines", "number", cfg.pasteCollapseLines, (v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 0) cfg.pasteCollapseLines = n;
        }, {
          description: "Pastes with ≥ this many lines collapse to a paste file + one token. 0 disables.",
          defaultValue: DEFAULTS.pasteCollapseLines,
        }),
        row("attachments.pasteCollapseChars", "Paste collapse chars", "number", cfg.pasteCollapseChars, (v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 0) cfg.pasteCollapseChars = n;
        }, {
          description: "Pastes with ≥ this many characters collapse even below the line threshold (minified JSON walls). 0 disables.",
          defaultValue: DEFAULTS.pasteCollapseChars,
        }),
      ],
    },
  ];
}

const OWNED_PREFIX = "attachments.";

/** attachments' ModuleConfig for the central /config panel. */
export function attachmentsConfig(): ModuleConfig {
  const before = loadSettings();
  const working: AttachmentsSettings = { ...before };

  return {
    groups: () => buildAttachmentsGroups(working),
    save: async (edited, ctx) => {
      const FIELDS: (keyof AttachmentsSettings)[] = [
        "inlineTextFiles", "maxInlineBytes", "pasteFileShortcut", "pasteCollapseLines", "pasteCollapseChars",
      ];
      const patch: Partial<AttachmentsSettings> = {};
      for (const key of edited) {
        if (!key.startsWith(OWNED_PREFIX)) continue;
        const field = key.slice(OWNED_PREFIX.length) as keyof AttachmentsSettings;
        if (FIELDS.includes(field)) (patch as Record<string, unknown>)[field] = working[field];
      }
      if (!Object.keys(patch).length) return;
      try {
        const file = writeAttachmentsSection(patch);
        ctx.ui.notify(`Attachments settings saved to ${file} — applies next session (shortcut: full restart).`, "info");
      } catch (e) {
        ctx.ui.notify(`Attachments save failed: ${e instanceof Error ? e.message : e}`, "error");
      }
    },
  };
}
