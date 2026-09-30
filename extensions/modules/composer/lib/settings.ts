/**
 * `composer.shape` persistence in the agent-dir settings.json — copied from
 * router/lib/config.ts (read-modify-write merge, atomic tmp+rename, refuse to
 * clobber a corrupt file).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { DEFAULT_SHAPE, isShapeId } from "./shapes.ts";

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function settingsPath(): string {
  return join(agentDir(), "settings.json");
}

export function readComposerShape(): string {
  try {
    if (!existsSync(settingsPath())) return DEFAULT_SHAPE;
    const shape = (JSON.parse(readFileSync(settingsPath(), "utf8")) as { composer?: { shape?: unknown } }).composer?.shape;
    return isShapeId(shape) ? shape : DEFAULT_SHAPE;
  } catch {
    return DEFAULT_SHAPE;
  }
}

/** Merge `patch` into the global settings.json `composer` section. Atomic
 *  (tmp+rename); a corrupt file refuses to clobber (same data-loss guard as
 *  writeRouterSection). */
export function writeComposerSection(patch: { shape?: string }): void {
  const file = settingsPath();
  let settings: Record<string, unknown> | null = {};
  try {
    if (existsSync(file)) {
      settings = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    }
  } catch {
    // Corrupt ≠ missing: a {} fallback would make the rename below overwrite
    // the file with ONLY the composer section, destroying every other key.
    settings = null;
  }
  if (settings === null) {
    throw new Error(`${file} is not valid JSON — fix or remove it before saving.`);
  }
  const composer = (settings.composer ?? {}) as Record<string, unknown>;
  if (patch.shape !== undefined) composer.shape = patch.shape;
  settings.composer = composer;
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}
