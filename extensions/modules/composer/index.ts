/**
 * composer module — Composer Shape for the input editor. CORE: always on,
 * not kill-switchable (it owns the editor surface; a half-configured composer
 * is worse than none).
 *
 * Pick a shape in /config (Appearance → Composer Shape) with a live preview
 * window in the panel; Enter applies it to the running editor immediately and
 * persists `composer.shape` to the global settings.json. Browsing only moves
 * the panel's preview block — it never mutates the live editor (OMP previews
 * in-window and commits on Enter).
 *
 * Session lifecycle: `session_start` is the only hook needed — it fires for
 * startup/new/resume/fork/reload, and pi's beforeSessionInvalidate clears
 * custom editors before the replacement session's session_start re-arms this
 * handler (same reliance as the usage module's ctx grab).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModuleConfig } from "../../lib/registry.js";
import { row, type PanelGroup, type PanelMenuOption } from "../../lib/panel.js";
import { DEFAULT_SHAPE, IDENTITY_THEME, isShapeId, previewShape, ShapeEditor, shapeById, shapeTheme, SHAPES, type BandData, type ShapeTheme } from "./lib/shapes.ts";
import { readComposerShape, writeComposerSection } from "./lib/settings.ts";

/** Live band/status data from the freshest session ctx; blank rather than stale. */
let liveCtx: ExtensionContext | undefined;

function shapeData(ctx: ExtensionContext | undefined): BandData {
  if (!ctx) return {};
  try {
    return {
      model: ctx.model?.name,
      cwd: ctx.cwd ? ctx.cwd.split(/[\\/]/).filter(Boolean).pop() : undefined,
      pct: ctx.getContextUsage()?.percent ?? null,
    };
  } catch {
    return {};
  }
}

/** Theme styling read LIVE per call: pi's theme object is a Proxy over a
 *  globalThis slot, so every render/preview picks up the current theme. */
function currentTheme(ctx: ExtensionContext | undefined): ShapeTheme {
  try {
    const t = ctx?.ui?.theme;
    return t ? shapeTheme(t) : IDENTITY_THEME;
  } catch {
    return IDENTITY_THEME;
  }
}

/** Apply the shape to the RUNNING editor. Guards the TUI-only API and
 *  feature-detects `setEditorComponent` (peer-range floor predates it).
 *  Exported for tests. */
export function applyShape(shape: string, ctx: ExtensionContext): void {
  if (ctx.mode !== "tui" || !ctx.hasUI || typeof ctx.ui.setEditorComponent !== "function") return;
  const def = shapeById(isShapeId(shape) ? shape : DEFAULT_SHAPE);
  ctx.ui.setEditorComponent(
    (tui, theme, keybindings) =>
      new ShapeEditor(def, { theme: () => currentTheme(liveCtx), data: () => shapeData(liveCtx) }, tui, theme, keybindings, {
        embedWorkingStatus: true,
      }),
  );
}

/** The /config menu options — OMP's label + description per shape (the
 *  description is the whole point of the selection screen). */
export function shapeOptions(): PanelMenuOption[] {
  return SHAPES.map((s) => ({ value: s.id, label: s.label, description: s.description }));
}

/** Build the composer panel groups over a working value (mutated by the row
 *  setter). Exported for tests. */
export function buildComposerGroups(working: { shape: string }): PanelGroup[] {
  return [
    {
      key: "composer",
      label: "Composer Shape",
      tab: "Appearance",
      icon: "🎨",
      rows: [
        row("composer.shape", "Shape", "string", working.shape, (v) => {
          working.shape = isShapeId(v) ? String(v) : DEFAULT_SHAPE;
        }, {
          menu: shapeOptions,
          defaultValue: DEFAULT_SHAPE,
          description: "Visual layout of the input editor and status line. Browsing previews below; Enter applies to the running editor.",
          // OMP's preview window: rendered through the SAME chrome builders
          // the live editor uses (no-drift), at the body's inner width, with
          // live session data. Never mutates the live editor (see module doc).
          previewLines: (v, width) => {
            try {
              return previewShape(isShapeId(v) ? v : DEFAULT_SHAPE, Math.max(20, width), currentTheme(liveCtx), shapeData(liveCtx));
            } catch {
              return [];
            }
          },
        }),
      ],
    },
  ];
}

const OWNED_KEYS = ["composer.shape"];

/** Composer's ModuleConfig for the central /config panel. */
export function composerConfig(_pi?: ExtensionAPI): ModuleConfig {
  const working = { shape: readComposerShape() };
  return {
    groups: () => buildComposerGroups(working),
    save: async (edited, ctx) => {
      if (!OWNED_KEYS.some((k) => edited.has(k))) return;
      writeComposerSection({ shape: working.shape });
      liveCtx = ctx;
      applyShape(working.shape, ctx);
      ctx.ui.notify(`Composer shape saved — ${shapeById(working.shape).label} applied.`, "info");
    },
  };
}

export default function composerModule(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    liveCtx = ctx;
    applyShape(readComposerShape(), ctx);
  });
  pi.on("session_shutdown", async () => {
    liveCtx = undefined;
  });
}
