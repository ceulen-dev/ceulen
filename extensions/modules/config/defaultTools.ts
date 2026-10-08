/**
 * Pi's built-in tools as /config toggles over the `defaultTools` setting.
 *
 * Rows live on the Tools tab ("Built-in tools" section): one toggle per
 * built-in tool plus the two built-in extension tools (codemode,
 * tool_search). The stock four (read, bash, edit, write) default on — pi
 * enables exactly those unless `defaultTools` changes them. A plain-list
 * write only replaces the BUILT-IN startup selection; extension tools with
 * `defaultActive: true` still self-activate, so ceulen's tools are never
 * touched. Save persists to the GLOBAL settings.json (pi's typed-setter
 * convention) with the shared atomic-write pattern and applies to the live
 * session via applyToolSwitches (see index.ts) — the ONE exception to
 * piSettings.ts's typed-setter-only coverage rule, because SettingsManager
 * exposes getDefaultTools() but no setter.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { row, type PanelRow } from "../../lib/panel.js";
import { agentDirs } from "../../lib/registry.js";

/** Tools enabled at startup when `defaultTools` does not change them —
 *  pi's DEFAULT_TOOL_NAMES (core/settings-manager.js), replicated locally
 *  because pi does not export it from the package root. */
export const STOCK_DEFAULT_TOOLS = ["read", "bash", "edit", "write"] as const;

/** Every built-in tool the panel offers, in render order. Blurbs from pi's
 *  CLI docs. codemode is a built-in EXTENSION tool, off by default; MCP
 *  activates it automatically when a server needs it. tool_search is NOT
 *  offered: ceulen's deferred tool tier depends on it, and the bundle entry
 *  re-activates it every session_start — a toggle here would be silently
 *  overridden (ceulen owns the switch, MCP-activates-codemode precedent). */
const BUILTIN_TOOLS: readonly { name: string; blurb: string }[] = [
  { name: "read", blurb: "Read text files and supported images." },
  { name: "bash", blurb: "Run shell commands." },
  { name: "powershell", blurb: "Run PowerShell commands (registered everywhere, useful on Windows)." },
  { name: "edit", blurb: "Apply exact text replacements to an existing file." },
  { name: "write", blurb: "Create or overwrite a file." },
  { name: "grep", blurb: "Search file contents." },
  { name: "find", blurb: "Find paths using glob patterns." },
  { name: "ls", blurb: "List directory contents." },
  { name: "codemode", blurb: "Run JavaScript that calls the other tools. MCP turns it on when needed." },
];

export const DEFAULT_TOOLS_PREFIX = "pi.defaultTools.";

/** The effective startup selection: the resolved `defaultTools` merged over
 *  all layers, or the stock four when no layer sets it. */
export function startupToolSet(m: SettingsManager): Set<string> {
  return new Set(m.getDefaultTools() ?? STOCK_DEFAULT_TOOLS);
}

/** Toggle row per built-in tool over a live working Set of ENABLED names.
 *  Toggles mutate the set; persistence happens in the /config save path. */
export function builtinToolRows(working: Set<string>): PanelRow[] {
  return BUILTIN_TOOLS.map(({ name, blurb }) =>
    row(`${DEFAULT_TOOLS_PREFIX}${name}`, name, "toggle", working.has(name), (v) => {
      if (v) working.add(name);
      else working.delete(name);
    }, {
      defaultValue: (STOCK_DEFAULT_TOOLS as readonly string[]).includes(name),
      description: `${blurb} Enabled at startup for new sessions; writes the global settings.json and applies to this session immediately on save.`,
    }),
  );
}

/** The absolute defaultTools list that results from toggling `working`
 *  (BUILTIN_TOOLS order, deterministic). Pure — exported for tests. */
export function nextDefaultTools(working: Set<string>): string[] {
  return BUILTIN_TOOLS.map(({ name }) => name).filter((n) => working.has(n));
}

/** Write the startup selection into the GLOBAL agent settings.json (the same
 *  file pi's typed setters target). A list equal to the stock four DELETES
 *  the key — that is pi's reset semantics, and it keeps the selection
 *  following future stock-default changes. Atomic (tmp + rename); a corrupt
 *  file refuses to clobber. Returns the written path for disclosure. */
export function writeDefaultTools(list: string[], file = path.join(agentDirs()[0]!, "settings.json")): string {
  let settings: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      settings = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      throw new Error(`${file} is not valid JSON — fix or remove it before saving.`);
    }
  }
  if (list.length === STOCK_DEFAULT_TOOLS.length && STOCK_DEFAULT_TOOLS.every((n) => list.includes(n))) {
    delete settings.defaultTools;
  } else {
    settings.defaultTools = list;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
  return file;
}
