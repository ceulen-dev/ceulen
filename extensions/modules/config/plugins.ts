/**
 * Pi-package management for the /config panel ("Plugins" group).
 *
 * Pi stores installed packages in the `packages` array of settings.json
 * (global agent dir, plus the trusted project's .pi/settings.json). The load
 * contract in Pi's package manager:
 *
 *   - string entry                    → load everything the package declares
 *   - object entry, resource array [] → "Empty array explicitly disables all
 *     resources of this type" (package-manager.js applyPackageFilter)
 *   - object entry with patterns      → per-resource narrowing (pi config)
 *   - object entry, autoload: false   → project-scope FILTER DELTA over a
 *     personal entry, not an install
 *
 * So whole-package on/off is: string ⇄ object with all four resource arrays
 * empty. Entries carrying patterns or autoload:false are read-only here —
 * re-shaping them would silently drop a user's granular `pi config` setup.
 *
 * Writes go to the SAME file the entry lives in (project entries stay in the
 * project file), atomic tmp+rename, corrupt file refuses to clobber — the
 * same data-loss guard as writeDisabled.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { agentDirs, isProjectTrusted } from "../../lib/registry.js";
import { row, type PanelGroup } from "../../lib/panel.js";

/** Pi's resource types (package-manager.js RESOURCE_TYPES). */
const RESOURCE_KEYS = ["extensions", "skills", "prompts", "themes"] as const;

export type PackageScope = "global" | "project";
/** on = string entry; off = all-empty-array object; filtered = patterns or
 *  autoload:false — managed by `pi config`, not toggleable here. */
export type PackageState = "on" | "off" | "filtered";

export interface PackageEntry {
  scope: PackageScope;
  /** Index into that file's `packages` array (write-back position). */
  index: number;
  source: string;
  state: PackageState;
  /** True when the entry is a project filter delta (autoload: false). */
  delta: boolean;
}

/** One settings file's package array (raw, for read-modify-write). */
export interface PackageFile {
  path: string;
  scope: PackageScope;
  packages: unknown[];
}

export const PLUGINS_PREFIX = "ceulen.plugins.";

function globalSettingsPath(): string {
  return path.join(agentDirs()[0]!, "settings.json");
}

function projectSettingsPath(cwd: string): string {
  return path.join(cwd, ".pi", "settings.json");
}

/** Package arrays in Pi's load order: project first (it can shadow/delta
 *  global entries), then global. The project file is only eligible when
 *  trusted — an untrusted checkout's packages never load, so showing them
 *  would misrepresent the session. */
export function readPackageFiles(cwd = process.cwd()): PackageFile[] {
  const files: PackageFile[] = [];
  const projectFile = projectSettingsPath(cwd);
  if (isProjectTrusted(cwd) && existsSync(projectFile)) {
    const pkgs = readPackagesFrom(projectFile);
    if (pkgs.length > 0) files.push({ path: projectFile, scope: "project", packages: pkgs });
  }
  const globalFile = globalSettingsPath();
  if (existsSync(globalFile)) {
    const pkgs = readPackagesFrom(globalFile);
    if (pkgs.length > 0) files.push({ path: globalFile, scope: "global", packages: pkgs });
  }
  return files;
}

/** The raw `packages` array of one settings file ([] on missing/corrupt —
 *  reads never throw; the WRITE path refuses a corrupt file instead). */
export function readPackagesFrom(file: string): unknown[] {
  try {
    const json = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    return Array.isArray(json.packages) ? json.packages : [];
  } catch {
    return [];
  }
}

/** Entry state per the load contract above:
 *  - string                          → on
 *  - object, autoload:false          → filtered (project delta — pi config owns it)
 *  - object, no resource arrays      → on (loads package defaults)
 *  - object, ALL four arrays empty   → off (Pi: "empty array disables all")
 *  - object, patterns or partial []  → filtered (granular pi config setup) */
export function packageState(pkg: unknown): PackageState {
  if (typeof pkg === "string") return "on";
  if (pkg && typeof pkg === "object") {
    const o = pkg as Record<string, unknown>;
    if (o.autoload === false) return "filtered";
    const arrays = RESOURCE_KEYS.filter((k) => Array.isArray(o[k]));
    if (arrays.length === 0) return "on";
    const allEmpty = arrays.every((k) => (o[k] as unknown[]).length === 0);
    return allEmpty && arrays.length === RESOURCE_KEYS.length ? "off" : "filtered";
  }
  return "filtered";
}

/** The source string of an entry, whatever its shape. */
export function packageSource(pkg: unknown): string {
  if (typeof pkg === "string") return pkg;
  if (pkg && typeof pkg === "object") {
    const source = (pkg as Record<string, unknown>).source;
    if (typeof source === "string") return source;
  }
  return "";
}

/** Flat list of toggleable/visible entries across both scopes, project first. */
export function readPackageEntries(cwd = process.cwd()): PackageEntry[] {
  const out: PackageEntry[] = [];
  for (const file of readPackageFiles(cwd)) {
    for (let i = 0; i < file.packages.length; i++) {
      const pkg = file.packages[i];
      const source = packageSource(pkg);
      if (!source) continue; // malformed entry — not ours to represent
      const isObj = typeof pkg === "object" && pkg !== null;
      out.push({
        scope: file.scope,
        index: i,
        source,
        state: packageState(pkg),
        delta: isObj && (pkg as Record<string, unknown>).autoload === false,
      });
    }
  }
  return out;
}

/** Display label: npm scope+name without version/prefix; path basename for
 *  local/git sources. */
export function packageLabel(source: string): string {
  let s = source;
  if (s.startsWith("npm:")) {
    s = s.slice(4);
    // Strip a trailing @version — an @ AFTER the last "/" is a version; one
    // before it is the scope, which stays: @a-fig/accordion reads better than
    // a bare name that collides across registries.
    const at = s.lastIndexOf("@");
    if (at > s.lastIndexOf("/")) s = s.slice(0, at);
    return s;
  }
  else if (s.startsWith("git:")) s = s.slice(4);
  else if (s.startsWith("http://")) s = s.slice(7);
  else if (s.startsWith("https://")) s = s.slice(8);
  else if (s.startsWith("./") || s.startsWith("../") || s.startsWith("/")) {
    const base = s.replace(/\/+$/, "").split("/").pop();
    return base || s;
  }
  s = s.replace(/\.git$/, "").replace(/\/+$/, "");
  // Strip a trailing @version/@ref — but NOT a leading npm scope: an @ that
  // sits after the last "/" is a version/ref, one before it is the scope.
  const at = s.lastIndexOf("@");
  if (at > s.lastIndexOf("/")) s = s.slice(0, at);
  return s.split("/").pop() ?? s;
}

/** The replacement value that flips an entry to `enabled` (string form) or
 *  `disabled` (object with every resource list empty — Pi's whole-off form).
 *  Unknown entry shapes pass through untouched (filtered entries are not
 *  editable). */
export function flipPackage(pkg: unknown, enabled: boolean): unknown {
  if (packageState(pkg) === "filtered") return pkg;
  const source = packageSource(pkg);
  if (!source) return pkg;
  if (enabled) return source;
  return { source, extensions: [], skills: [], prompts: [], themes: [] };
}

/** Persist a changed packages array back into its settings file (merge, atomic,
 *  corrupt-refusal). Returns the written path. */
export function writePackages(file: string, packages: unknown[]): string {
  let settings: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      settings = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      throw new Error(`${file} is not valid JSON — fix or remove it before saving.`);
    }
  }
  settings.packages = packages;
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
  return file;
}

/** Working state for the panel: the packages arrays cloned at open, mutated
 *  in place by row setters, then diffed on save. */
export interface PluginsWorking {
  files: { path: string; scope: PackageScope; packages: unknown[] }[];
}

export function openPluginsWorking(cwd = process.cwd()): PluginsWorking {
  return {
    files: readPackageFiles(cwd).map((f) => ({
      path: f.path,
      scope: f.scope,
      packages: structuredClone(f.packages),
    })),
  };
}

function stateOf(state: PackageState): { value: boolean | string; kind: "toggle" | "info" } {
  if (state === "filtered") return { value: "custom filters", kind: "info" };
  return { value: state === "on", kind: "toggle" };
}

/** Build the PLUGINS contribution: one group per scope — project packages and
 *  global packages are separate SECTIONS (same `tab`, so the panel shows one
 *  Plugins tab with a Global/Project sidebar). A discoverability hint row
 *  appears when nothing is installed. Row setters mutate the working copy;
 *  save() diffs it against disk. */
export function buildPluginsGroups(working: PluginsWorking): PanelGroup[] {
  const groups: PanelGroup[] = working.files.map((file) => ({
    key: `plugins-${file.scope}`,
    label: file.scope === "project" ? "Project" : "Global",
    tab: "Plugins",
    icon: "📦",
    rows: file.packages.flatMap((pkg, i) => {
      const source = packageSource(pkg);
      if (!source) return [];
      const state = packageState(pkg);
      const isObj = typeof pkg === "object" && pkg !== null;
      const delta = isObj && (pkg as Record<string, unknown>).autoload === false;
      const { value, kind } = stateOf(state);
      const scopeNote = file.scope === "project" ? "project" : "global";
      const detail = delta
        ? "Project filter delta over a personal package (managed by pi config)."
        : state === "filtered"
          ? "Per-resource filters set (managed by pi config)."
          : "Takes effect after /reload (or restart).";
      return [
        row(`${PLUGINS_PREFIX}${scopeNote}.${i}`, packageLabel(source), kind, value, (v) => {
          if (state === "filtered") return; // read-only
          file.packages[i] = flipPackage(file.packages[i], Boolean(v));
        }, {
          description: `${source} · ${scopeNote}. ${detail}`,
        }),
      ];
    }),
  }));

  if (groups.length === 0) {
    groups.push({
      key: "plugins-none",
      label: "Plugins",
      tab: "Plugins",
      icon: "📦",
      rows: [
      row(`${PLUGINS_PREFIX}none`, "(no packages installed)", "info", "", () => {}, {
        description: "Install with `pi install npm:<package>` or `pi install ./path`.",
      }),
      ],
    });
  }
  return groups;
}

/** Keys this group owns (for save routing). */
export function isPluginsKey(key: string): boolean {
  return key.startsWith(PLUGINS_PREFIX);
}

/** Write every file whose working array differs from disk. Returns written
 *  paths. Throws before writing anything if a file is corrupt. */
export function savePlugins(working: PluginsWorking): string[] {
  const written: string[] = [];
  for (const file of working.files) {
    const before = readPackagesFrom(file.path);
    if (JSON.stringify(before) === JSON.stringify(file.packages)) continue;
    written.push(writePackages(file.path, file.packages));
  }
  return written;
}
