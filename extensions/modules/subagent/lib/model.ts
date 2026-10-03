// ponytail: vendored from @bacnh85/pi-subagent 0.23.2 (extensions/model.ts)
/**
 * Shared model resolution for pi-subagent.
 *
 * Provides a single canonical resolveModel() used by both the tool handler
 * (index.ts) and the event-driven service path (service.ts), ensuring
 * consistent error reporting across all sub-agent invocation paths.
 *
 * Selects the first authenticated candidate reported by the parent
 * ModelRegistry, then falls back to the authenticated parent model.
 * For unqualified names (no provider prefix), known naming conventions
 * are tried before assuming Anthropic.
 */

import type { Model } from "./types.ts";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { splitThinkingSuffix, type SubagentThinkingLevel } from "./roles.ts";

export interface ResolvedModel {
  model: Model | null;
  attempted: string[];
  /** The raw candidate name that matched, if a candidate resolved. Undefined for parent fallback. */
  matchedCandidate?: string;
  /** Thinking level carried by the matched candidate's `:level` suffix, if any. */
  matchedThinking?: SubagentThinkingLevel;
}

/** Known provider prefixes for unqualified model names. */
const KNOWN_PROVIDERS: [string, RegExp][] = [
  ["openai", /^gpt-/i],
  ["anthropic", /^claude-/i],
  ["google", /^gemini-/i],
  ["cohere", /^command-/i],
  ["deepseek", /^(deepseek-|ds-)/i],
  ["mistral", /^mistral-/i],
  ["groq", /^(groq-|llama-)/i],
];

export async function resolveModel(
  modelNames: readonly string[],
  parentModel: Model | undefined,
  modelRegistry?: ModelRegistry,
): Promise<ResolvedModel> {
  const attempted: string[] = [];
  const available = modelRegistry?.getAvailable() ?? [];
  const byName = new Map(available.map((model) => [`${model.provider}/${model.id}`, model]));
  const tryAvailable = (qualifiedName: string): Model | undefined => {
    if (!attempted.includes(qualifiedName)) attempted.push(qualifiedName);
    return byName.get(qualifiedName);
  };

  for (const modelName of [...new Set(modelNames.map((name) => name.trim()).filter(Boolean))]) {
    const { name: bareName, thinking } = splitThinkingSuffix(modelName);
    const idx = bareName.indexOf("/");
    if (idx > 0) {
      const found = tryAvailable(bareName);
      if (found) return { model: found, attempted, matchedCandidate: modelName, matchedThinking: thinking };
      continue;
    }
    for (const [provider, pattern] of KNOWN_PROVIDERS) {
      if (!pattern.test(bareName)) continue;
      const found = tryAvailable(`${provider}/${bareName}`);
      if (found) return { model: found, attempted, matchedCandidate: modelName, matchedThinking: thinking };
    }
    const found = tryAvailable(`anthropic/${bareName}`);
    if (found) return { model: found, attempted, matchedCandidate: modelName, matchedThinking: thinking };
  }

  if (parentModel) {
    const found = tryAvailable(`${parentModel.provider}/${parentModel.id}`);
    if (found) return { model: found, attempted };
  }
  return { model: null, attempted };
}

// ---------------------------------------------------------------------------
// Rate-limit model fallback (shared by tool path and service path)
// ---------------------------------------------------------------------------

export type ModelFallbackExhaustReason = "no-model" | "already-tried" | "parent-rate-limited";

export interface ModelFallbackOptions<T> {
  candidates: readonly string[];
  parentModel: Model | undefined;
  modelRegistry?: ModelRegistry;
  /** thinking suffix per stripped candidate name (from resolveAgentModelChain). */
  thinkingByCandidate: ReadonlyMap<string, SubagentThinkingLevel>;
  /** Fallback thinking when no candidate carries a `:level` suffix. */
  defaultThinking?: SubagentThinkingLevel;
  runAttempt: (model: Model, thinkingLevel: SubagentThinkingLevel | undefined) => Promise<T>;
  isRateLimited: (result: T) => boolean;
  /** Build the terminal value when all models are exhausted (path-specific error mapping). */
  onExhausted: (reason: ModelFallbackExhaustReason, triedModels: string[], remaining: string[]) => T;
}

/**
 * Retry loop shared by the tool handler (index.ts) and the event-driven
 * service path (service.ts): try candidates in priority order, falling back to
 * the parent model, advancing on rate-limit errors. Single source of truth for
 * `triedModels` bookkeeping and per-candidate `:thinking` resolution.
 */
export async function runWithModelFallback<T>(options: ModelFallbackOptions<T>): Promise<T> {
  const {
    candidates,
    parentModel,
    modelRegistry,
    thinkingByCandidate,
    defaultThinking,
    runAttempt,
    isRateLimited,
    onExhausted,
  } = options;
  const triedModels: string[] = [];

  const attempt = async (): Promise<T> => {
    const remaining = candidates.filter((m) => !triedModels.includes(m));
    const isParentFallback = remaining.length === 0;
    const fallbackResolved = await resolveModel(remaining, parentModel, modelRegistry);
    if (!fallbackResolved.model) {
      return onExhausted("no-model", triedModels, remaining);
    }
    const triedName = `${fallbackResolved.model!.provider}/${fallbackResolved.model!.id}`;
    if (triedModels.includes(triedName)) {
      // Already tried this model (e.g., all candidates unavailable
      // and parent fallback) — no further options.
      return onExhausted("already-tried", triedModels, remaining);
    }
    triedModels.push(triedName);
    // Also track the raw candidate name so candidates.filter() can
    // exclude it even when the agent uses unqualified names.
    // Avoid duplicating when candidate name is already qualified (matchedCandidate === triedName).
    if (fallbackResolved.matchedCandidate && fallbackResolved.matchedCandidate !== triedName) {
      triedModels.push(fallbackResolved.matchedCandidate);
    }

    // The `:thinking` suffix lives on the candidate as written; resolve it from
    // the stripped-name map (matchedCandidate is the raw candidate string).
    const thinkingLevel =
      thinkingByCandidate.get(fallbackResolved.matchedCandidate ?? triedName) ??
      fallbackResolved.matchedThinking ??
      defaultThinking;

    const result = await runAttempt(fallbackResolved.model, thinkingLevel);
    if (result && isRateLimited(result)) {
      // If the model that just rate-limited was the parent fallback
      // (no remaining candidates), stop — no further options.
      if (isParentFallback) {
        return onExhausted("parent-rate-limited", triedModels, remaining);
      }
      return attempt();
    }
    return result;
  };

  return attempt();
}
