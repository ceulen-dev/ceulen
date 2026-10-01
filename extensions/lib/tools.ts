/**
 * Shared per-tool kill-switch: `ceulen.disabledTools: string[]` in the SAME
 * settings file `ceulen.disabled` resolves to (see registry.ts). Listed tool
 * names register inactive (`defaultActive: false`); the /config panel's
 * tool rows write this key and re-activate/deactivate live via
 * `pi.setActiveTools`, so a toggle needs no /reload.
 */

import { disabledSource } from "./registry.js";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Read the `ceulen.disabledTools` list (non-string entries dropped). */
export function readDisabledTools(cwd = process.cwd()): Set<string> {
  const { path: file } = disabledSource(cwd);
  if (!existsSync(file)) return new Set();
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"))?.ceulen ?? {};
    if (!Array.isArray(raw.disabledTools)) return new Set();
    return new Set(raw.disabledTools.filter((n: unknown): n is string => typeof n === "string"));
  } catch {
    return new Set(); // malformed → defaults (all tools on)
  }
}

/** Write `ceulen.disabledTools` into the SAME file readDisabledTools resolves
 *  to (never a shadowed layer). Atomic (tmp + rename); a corrupt file refuses
 *  to clobber. Returns the written path for the caller's disclosure. */
export function writeDisabledTools(list: string[], cwd = process.cwd()): string {
  const { path: file } = disabledSource(cwd);
  let settings: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      settings = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      throw new Error(`${file} is not valid JSON — fix or remove it before saving.`);
    }
  }
  const ceulen = (settings.ceulen ?? {}) as Record<string, unknown>;
  ceulen.disabledTools = list.filter((n) => typeof n === "string");
  settings.ceulen = ceulen;
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
  return file;
}
