/**
 * Settings from the `attachments` key of Pi's settings.json
 * (~/.pi/agent/settings.json, or PI_CODING_AGENT_DIR). Non-secret only.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AttachmentsSettings {
  /**
   * When true, text-file attachments are inlined as <file> blocks (Claude Code
   * @file style — content dumped into context, re-read every turn).
   * When false (default), they resolve to a 📎 path the model reads on demand.
   */
  inlineTextFiles: boolean;
  /** Max bytes for text-file inlining (inlineTextFiles mode only). Default 100_000. */
  maxInlineBytes: number;
  /** Keybinding for paste-file-from-clipboard. Default "alt+shift+v". */
  pasteFileShortcut: string;
  /** Pastes with ≥ this many lines collapse to a paste file + token. 0 disables. Default 10. */
  pasteCollapseLines: number;
  /** Pastes with ≥ this many chars collapse even below the line threshold. 0 disables. Default 2000. */
  pasteCollapseChars: number;
}

export const DEFAULTS: AttachmentsSettings = {
  inlineTextFiles: false,
  maxInlineBytes: 100_000,
  pasteFileShortcut: "alt+shift+v",
  pasteCollapseLines: 10,
  pasteCollapseChars: 2000,
};

/** Read-modify-write `attachments.*` keys into the GLOBAL settings.json
 *  (merge, never clobber; atomic tmp+rename; a corrupt file refuses to clobber).
 *  Only the given patch keys are written. Returns the written path.
 *  Exported for tests + the /config save path. */
export function writeAttachmentsSection(patch: Partial<AttachmentsSettings>): string {
  const file = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "settings.json");
  let settings: Record<string, unknown>;
  try {
    settings = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : {};
  } catch {
    throw new Error(`${file} is not valid JSON — fix or remove it before saving.`);
  }
  const s = (settings.attachments ?? {}) as Record<string, unknown>;
  Object.assign(s, patch);
  settings.attachments = s;
  mkdirSync(join(file, ".."), { recursive: true });
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
  return file;
}

export function loadSettings(): AttachmentsSettings {
  const dir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  const p = join(dir, "settings.json");
  if (!existsSync(p)) return { ...DEFAULTS };
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8"))?.attachments ?? {};
    return {
      inlineTextFiles: typeof raw.inlineTextFiles === "boolean" ? raw.inlineTextFiles : DEFAULTS.inlineTextFiles,
      maxInlineBytes: typeof raw.maxInlineBytes === "number" && raw.maxInlineBytes > 0 ? raw.maxInlineBytes : DEFAULTS.maxInlineBytes,
      pasteFileShortcut: typeof raw.pasteFileShortcut === "string" && raw.pasteFileShortcut ? raw.pasteFileShortcut : DEFAULTS.pasteFileShortcut,
      pasteCollapseLines: typeof raw.pasteCollapseLines === "number" && raw.pasteCollapseLines >= 0 ? raw.pasteCollapseLines : DEFAULTS.pasteCollapseLines,
      pasteCollapseChars: typeof raw.pasteCollapseChars === "number" && raw.pasteCollapseChars >= 0 ? raw.pasteCollapseChars : DEFAULTS.pasteCollapseChars,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/* Runtime mirror of pi-tui's KeyId grammar: modifier(+modifier)*+base.
 * A value outside this grammar registers fine but never matches a key event
 * (the TUI compares against parsed KeyIds) — a silent no-op for the user. */
const MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);
// Lowercase entries — pi-tui lowercases the whole KeyId, so "pageUp" is
// parsed/compared as "pageup".
const SPECIAL_KEYS = new Set([
  "escape", "esc", "enter", "return", "tab", "space", "backspace", "delete", "insert", "clear",
  "home", "end", "pageup", "pagedown", "up", "down", "left", "right",
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);
const SYMBOL_KEYS = new Set("`-=[]\\;',./!@#$%^&*()_+|~{}:<>?".split(""));

/** True when `s` is a valid pi-tui KeyId (e.g. "alt+shift+v", "ctrl+enter", "f2").
 *  Matches pi-tui's parseKeyId exactly: case-insensitive (lowercases the whole
 *  id) and duplicate-modifier tolerant (parts.includes), so "Ctrl+Shift+V" and
 *  even "ctrl+ctrl+v" are real shortcuts — the validator must not warn about
 *  shortcuts pi-tui actually accepts. */
export function isValidShortcut(s: string): boolean {
  if (typeof s !== "string" || s.length === 0) return false;
  const parts = s.toLowerCase().split("+");
  const base = parts.pop()!;
  const isBase = /^[a-z0-9]$/.test(base) || SPECIAL_KEYS.has(base) || SYMBOL_KEYS.has(base);
  return isBase && parts.every((m) => MODIFIERS.has(m));
}
