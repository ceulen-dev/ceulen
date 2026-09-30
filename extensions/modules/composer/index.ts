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
import { getGenRate } from "../../lib/rate.js";
import { USAGE_STATUS_KEY, getUsageItem } from "../../lib/usage-store.js";
import { ComposerFooter, statsLine, sessionTotals } from "./lib/footer.ts";
import { formatCompact } from "./lib/shapes.ts";
import { execFile } from "node:child_process";
import { DEFAULT_SHAPE, IDENTITY_THEME, isShapeId, parseGitStats, previewShape, readGitBranch, ShapeEditor, shapeById, shapeTheme, SHAPES, type BandData, type GitStats, type ShapeTheme } from "./lib/shapes.ts";
import { readComposerShape, writeComposerSection } from "./lib/settings.ts";

/** Live band/status data from the freshest session ctx; blank rather than stale. */
let liveCtx: ExtensionContext | undefined;

/** Session-entry slice the footer totals read (structural; pi's entries fit). */
interface FooterDataLike {
  getExtensionStatuses(): ReadonlyMap<string, string>;
}

/** Session token stats for the band (pi-footer parity format). Cached by the
 *  same keys pi's own footer uses (session id + leaf + entry count) — the scan
 *  is O(entries) and the band renders per frame. */
let statsCache: { sessionId: string; leafId: string | null | undefined; count: number; stats: string } | undefined;

function bandStats(ctx: ExtensionContext | undefined): string {
  if (!ctx) return "";
  try {
    const sm = ctx.sessionManager;
    const sessionId = sm.getSessionId();
    const leafId = sm.getLeafId();
    const entries = sm.getEntries();
    if (statsCache && statsCache.sessionId === sessionId && statsCache.leafId === leafId && statsCache.count === entries.length) {
      return statsCache.stats;
    }
    const stats = statsLine(sessionTotals(entries as never));
    statsCache = { sessionId, leafId, count: entries.length, stats };
    return stats;
  } catch {
    return "";
  }
}

/** Extension `setStatus` items for the footer's last line — key-sorted like
 *  pi's own footer, minus the usage module's item (the band carries the quota
 *  windows; printing them twice is the duplication this footer exists to
 *  avoid). Read from the provider pi hands the factory. */
function footerStatuses(provider: FooterDataLike): string[] {
  try {
    return [...provider.getExtensionStatuses().entries()]
      .filter(([key]) => key !== USAGE_STATUS_KEY)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, text]) => text);
  } catch {
    return [];
  }
}

/** Install the narrowed footer. Shapes that embed the band already show
 *  model · cwd (branch) · context% — pi's native footer would duplicate them,
 *  so only its non-duplicated parts survive. Non-embedding shapes keep pi's
 *  native footer (there it is the only place that info appears). */
function applyFooter(shape: string, ctx: ExtensionContext): void {
  if (ctx.mode !== "tui" || !ctx.hasUI) return;
  if (typeof ctx.ui.setFooter !== "function") return;
  const embeds = shapeById(isShapeId(shape) ? shape : DEFAULT_SHAPE).embedsStatus === true;
  if (!embeds) {
    try {
      ctx.ui.setFooter(undefined);
    } catch {
      /* older/fake hosts */
    }
    return;
  }
  ctx.ui.setFooter((_tui, _theme, footerData) =>
    new ComposerFooter({
      statuses: () => footerStatuses(footerData as FooterDataLike),
    }),
  );
}

/** Branch cache: the status line re-renders per frame, `.git/HEAD` is read at
 *  most once per 2s (a checkout mid-session shows up on the next refresh). */
let branchCache: { cwd: string; branch: string | null; at: number } | undefined;

/** Auto-compaction armed — pi's footer `(auto)` marker on the context figure.
 *  Read from pi's own merged settings once per session (default on, pi parity). */
let liveAutoCompact: boolean | undefined;

/** Live thinking level — session_start's ctx value, then the
 *  `thinking_level_select` events (the ctx captured by session_start goes
 *  stale after a replacement session, so the event is the update path). */
let liveThinkingLevel: string | undefined;

function readAutoCompact(pi: ExtensionAPI): boolean | undefined {
  try {
    return (pi.getSettings?.() as { compaction?: { enabled?: boolean } } | undefined)?.compaction?.enabled ?? true;
  } catch {
    return undefined;
  }
}

function currentBranch(cwd: string): string | null {
  const now = Date.now();
  if (!branchCache || branchCache.cwd !== cwd || now - branchCache.at > 2000) {
    branchCache = { cwd, branch: readGitBranch(cwd), at: now };
  }
  return branchCache.branch;
}

/** Working-tree counts. `git status --porcelain` is a subprocess, so it runs
 *  at most once per 3s and NEVER blocks a render: the last result is returned
 *  while the next refresh is in flight. */
let gitCache: { cwd: string; stats: GitStats | null; at: number; inFlight: boolean } | undefined;

function currentGitStats(cwd: string): GitStats | null {
  const now = Date.now();
  if (!gitCache || gitCache.cwd !== cwd) {
    gitCache = { cwd, stats: null, at: 0, inFlight: false };
  }
  if (!gitCache.inFlight && now - gitCache.at > 3000) {
    gitCache.inFlight = true;
    gitCache.at = now;
    execFile("git", ["status", "--porcelain"], { cwd, timeout: 2000, maxBuffer: 1 << 20 }, (err, stdout) => {
      if (gitCache && gitCache.cwd === cwd) {
        gitCache.stats = err ? null : parseGitStats(stdout);
        gitCache.inFlight = false;
      }
    });
  }
  return gitCache.stats;
}

/** pi-footer parity: home directory renders as `~`. */
function displayCwd(cwd: string): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return cwd;
  const h = home.replace(/\/+$/, "");
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

function shapeData(ctx: ExtensionContext | undefined): BandData {
  if (!ctx) return {};
  try {
    const usage = ctx.getContextUsage();
    const model = ctx.model as { provider?: string; id?: string } | undefined;
    return {
      model: ctx.model?.name,
      provider: model?.provider,
      thinkingLevel: liveThinkingLevel,
      cwd: ctx.cwd ? displayCwd(ctx.cwd) : undefined,
      branch: ctx.cwd ? currentBranch(ctx.cwd) : null,
      git: ctx.cwd ? currentGitStats(ctx.cwd) : null,
      pct: usage?.percent ?? null,
      window: usage?.contextWindow,
      autoCompact: liveAutoCompact,
      rate: getGenRate().tps,
      usage: getUsageItem().windows,
      usageTone: getUsageItem().tone,
      stats: bandStats(ctx),
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
  applyFooter(def.id, ctx);
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
    liveAutoCompact = readAutoCompact(pi);
    liveThinkingLevel = ctx.thinkingLevel;
    applyShape(readComposerShape(), ctx);
  });
  pi.on("thinking_level_select", async (event) => {
    liveThinkingLevel = event.level;
  });
  pi.on("session_shutdown", async () => {
    liveCtx = undefined;
  });
}
