/**
 * advisor settings — ceulen module `advisor`, ported from pi-advisor 0.3.8.
 *
 *   ~/.pi/agent/settings.json          (write target, always)
 *   <cwd>/.pi/settings.json            (read only when the project is trusted)
 *
 *   "advisor": {
 *     "enabled": true,
 *     "models": ["router/zai/glm-5.3-flash:high", "opencode-go/deepseek-v4-pro"],
 *     "watch": { "minToolCalls": 3, "immuneTurns": 3 }
 *   }
 *
 * The standalone package's `pi-advisor` section is a READ-ONLY alias (new name
 * wins per field inside a file); the first save deletes it plus the legacy
 * `model` string and `watch.enabled` key, so nothing can shadow the new state
 * (pi-advisor's own rule for its legacy `model` key). Upstream's `watch.enabled`
 * — a second, finer-grained suppression — is folded into `enabled` at read time
 * so the runtime has exactly ONE switch.
 *
 * The pi-plan `advisorModel` one-shot migration is deliberately NOT ported:
 * pi-plan gets its own port and owns that key's migration then.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export const SECTION = "advisor";
export const LEGACY_SECTION = "pi-advisor";

export interface AdvisorWatchConfig {
  /** Trivial-turn gate: a review needs at least this many new tool calls. */
  minToolCalls: number;
  /** Post-steer calm-down window in settled turns (nit deferral + dedupe window). */
  immuneTurns: number;
}

export interface AdvisorConfig {
  /** Master switch: background review + the on-demand advisor tool. */
  enabled: boolean;
  /** Ordered fallback chain; empty = advisor off. First entry is primary. */
  models: string[];
  watch: AdvisorWatchConfig;
}

export const DEFAULT_WATCH: AdvisorWatchConfig = { minToolCalls: 3, immuneTurns: 3 };
export const DEFAULTS: AdvisorConfig = { enabled: true, models: [], watch: DEFAULT_WATCH };

type Raw = Record<string, unknown>;

/** Global agent-dir settings.json — ceulen's agent dir convention. */
export function agentSettingsPath(): string {
  const dir = process.env.PI_CODING_AGENT_DIR || join(homedir(), CONFIG_DIR_NAME, "agent");
  return join(dir, "settings.json");
}

/** Project settings file (read only when trusted — an untrusted checkout must
 *  not redirect the advisor's model, i.e. where the primary's key is spent). */
export function projectSettingsPath(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, "settings.json");
}

function readJson(file: string): Raw {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Raw;
    return value && typeof value === "object" ? value : {};
  } catch {
    return {}; // missing/unreadable → no layer
  }
}

const str = (raw: Raw, key: string): string | undefined => {
  const item = raw[key];
  return typeof item === "string" && item.trim() ? item.trim() : undefined;
};

const num = (raw: Raw, key: string): number | undefined => {
  const item = raw[key];
  return typeof item === "number" && Number.isFinite(item) && item >= 0 ? item : undefined;
};

/** Normalize a chain value (array or comma string) into trimmed, deduped entries. */
function parseModels(raw: Raw): string[] | undefined {
  const value = raw.models;
  if (value === undefined) return undefined;
  const entries = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : [];
  const models = entries.map((entry) => String(entry).trim()).filter(Boolean);
  return [...new Set(models)];
}

/** One section object (either name) → the flat field set we resolve over. */
interface Parsed {
  enabled?: boolean;
  models?: string[];
  /** Legacy single-model string (wraps to a one-entry chain). */
  model?: string;
  /** Legacy `watch.enabled` — folded into `enabled` by resolveSettings. */
  watchEnabled?: boolean;
  minToolCalls?: number;
  immuneTurns?: number;
}

export function parseSection(raw: unknown): Parsed {
  const s = raw && typeof raw === "object" ? (raw as Raw) : {};
  const watch = s.watch && typeof s.watch === "object" ? (s.watch as Raw) : {};
  const out: Parsed = {};
  if (typeof s.enabled === "boolean") out.enabled = s.enabled;
  const models = parseModels(s);
  if (models !== undefined) out.models = models;
  const model = str(s, "model");
  if (model) out.model = model;
  if (typeof watch.enabled === "boolean") out.watchEnabled = watch.enabled;
  const minToolCalls = num(watch, "minToolCalls");
  if (minToolCalls !== undefined) out.minToolCalls = minToolCalls;
  const immuneTurns = num(watch, "immuneTurns");
  if (immuneTurns !== undefined) out.immuneTurns = immuneTurns;
  return out;
}

/** Only-defined-keys merge (an explicit `undefined` never erases a lower layer). */
function over(base: Parsed, layer: Parsed): Parsed {
  const out = { ...base };
  for (const key of Object.keys(layer) as (keyof Parsed)[]) {
    if (layer[key] !== undefined) (out as Raw)[key] = layer[key];
  }
  return out;
}

/** One settings file's effective section: current name wins over the legacy alias. */
export function readLayer(settings: Raw): Parsed {
  return over(parseSection(settings[LEGACY_SECTION]), parseSection(settings[SECTION]));
}

/** Resolve layers in increasing precedence (global, then trusted project). */
export function resolveSettings(layers: Parsed[]): AdvisorConfig {
  const merged = layers.reduce(over, {} as Parsed);
  const models = merged.models && merged.models.length > 0 ? merged.models : merged.model ? [merged.model] : [];
  return {
    // Legacy `watch.enabled` folds into the master switch — one switch at runtime.
    enabled: (merged.enabled ?? true) && (merged.watchEnabled ?? true),
    models,
    watch: {
      minToolCalls: merged.minToolCalls ?? DEFAULT_WATCH.minToolCalls,
      immuneTurns: merged.immuneTurns ?? DEFAULT_WATCH.immuneTurns,
    },
  };
}

/** Effective settings: global file, then the trusted project file over it. */
export function loadAdvisorSettings(cwd: string = process.cwd(), trusted = false): AdvisorConfig {
  const layers: Parsed[] = [readLayer(readJson(agentSettingsPath()))];
  if (trusted) layers.push(readLayer(readJson(projectSettingsPath(cwd))));
  return resolveSettings(layers);
}

/** Which advisor sections a trusted project file sets — the panel/command warn
 *  that the project layer overrides a global save. Empty = no shadowing. */
export function projectShadow(cwd: string, trusted: boolean): string[] {
  if (!trusted) return [];
  const file = projectSettingsPath(cwd);
  if (!existsSync(file)) return [];
  const raw = readJson(file);
  return [LEGACY_SECTION, SECTION].filter((key) => raw[key] !== undefined);
}

/** Full-section write to the agent-dir settings.json (merge, never clobber;
 *  atomic tmp+rename; a corrupt file refuses to clobber). The caller passes the
 *  resolved settings, so deleting the folded legacy keys loses nothing. */
export function writeAdvisorSettings(settings: AdvisorConfig): string {
  const file = agentSettingsPath();
  let raw: Raw;
  try {
    raw = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Raw) : {};
  } catch {
    throw new Error(`${file} is not valid JSON — fix or remove it before saving.`);
  }
  delete raw[LEGACY_SECTION];
  const section = (raw[SECTION] && typeof raw[SECTION] === "object" ? (raw[SECTION] as Raw) : {});
  section.enabled = settings.enabled;
  const models = [...new Set(settings.models.map((m) => m.trim()).filter(Boolean))];
  if (models.length > 0) section.models = models;
  else delete section.models;
  delete section.model; // legacy single-model string can never shadow a saved chain
  const watch = (section.watch && typeof section.watch === "object" ? (section.watch as Raw) : {});
  watch.minToolCalls = settings.watch.minToolCalls;
  watch.immuneTurns = settings.watch.immuneTurns;
  delete watch.enabled; // legacy suppression, folded into `enabled` above
  section.watch = watch;
  raw[SECTION] = section;
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
  return file;
}

export function parseModel(value: string): { provider: string; id: string } | undefined {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return undefined;
  return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}

/** Thinking levels accepted as a trailing `:level` on a chain entry.
 *  `off` maps to "no explicit level" (SimpleStreamOptions.reasoning has no off). */
export const THINKING_LEVELS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Split a trailing `:thinking` suffix. Strict trailing match only — openrouter
 *  ids like `model:free` stay intact. */
export function splitThinkingSuffix(entry: string): { name: string; thinking?: string } {
  const idx = entry.lastIndexOf(":");
  if (idx <= 0 || idx >= entry.length - 1) return { name: entry };
  const suffix = entry.slice(idx + 1);
  if (!THINKING_LEVELS.includes(suffix)) return { name: entry };
  return { name: entry.slice(0, idx), thinking: suffix };
}

/** The three `/config` model rows ⇄ the saved chain. */
export interface AdvisorChain {
  /** Primary `provider/id`. */
  model: string;
  /** Pinned thinking for the primary (`""` = model default, `off` = no suffix). */
  thinking: string;
  /** Comma-separated `provider/id[:level]` fallbacks, in priority order. */
  fallbacks: string;
}

export function chainFromSettings(models: readonly string[]): AdvisorChain {
  const [primary = "", ...rest] = models;
  const { name, thinking } = splitThinkingSuffix(String(primary).trim());
  return {
    model: name,
    thinking: thinking && thinking !== "off" ? thinking : "",
    fallbacks: rest.map((m) => String(m).trim()).filter(Boolean).join(", "),
  };
}

export function settingsFromChain(chain: AdvisorChain): string[] {
  const out: string[] = [];
  const model = chain.model.trim();
  const thinking = chain.thinking.trim();
  if (model) out.push(thinking && thinking !== "off" ? `${model}:${thinking}` : model);
  for (const entry of chain.fallbacks.split(",")) {
    const trimmed = entry.trim();
    if (trimmed) out.push(trimmed);
  }
  return [...new Set(out)];
}
