// Classifier-assisted task routing for the subagent module.
//
// One Jev round-trip per task answers up to THREE questions at once:
//   tier     — which role's model pool should serve this task (fast/coder/smart)
//   effort   — how much thinking the task needs (score → :level suffix)
//   dispatch — inside herdr: a visible pane or a detached background task
//              (asked only when the caller left runner/background unspecified)
//
// Precedence (pins beat dynamic; dynamic beats defaults):
//   1. chain-entry `:level` suffix (user-authored, most specific)
//   2. `agentModels` pin  → disables BOTH overrides (no classify call is made)
//   3. `agentThinking` pin → disables the effort override only
//   4. classifier (tier + effort): tier gates on the WINNING LABEL'S probability
//      (`probabilities[choice]`, NOT the max across labels — a high-probability
//      rival must not clear the threshold for a low-confidence choice), effort
//      on the score answer's `confidence`; both must be >= threshold
//   5. agent frontmatter defaults (what the classifier amends; what applies
//      when routing is off / the call fails / confidence is low)
//
// Fail-open everywhere: routing can never block a dispatch.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";
import { resolveAgentModelChain, type RolesConfig } from "./roles.ts";

export type RoutingMode = "off" | "classify";
export type DispatchMode = "off" | "classify";

export interface RoutingSettings {
  mode: RoutingMode;
  /** herdr only: let the classify round-trip choose pane vs background for a
   *  single dispatch whose caller named neither runner nor background. */
  dispatch: DispatchMode;
  /** Optional classifier model override (provider/id or id); empty = first available. */
  model: string;
  /** Minimum certainty to act on an answer: tier = winning label's
   *  OWN probability, effort = the score answer's `confidence` field. */
  threshold: number;
}

export const DEFAULT_ROUTING: RoutingSettings = {
  mode: "classify",
  dispatch: "classify",
  model: "",
  threshold: 0.6,
};

/** Role the classifier may pick from — the ceulen role set. */
const TIERS = ["fast", "coder", "smart"] as const;
export type Tier = (typeof TIERS)[number];

/** Score criteria ladder → thinking level (index = score). */
export const EFFORT_LADDER: readonly { level: string; description: string }[] = [
  { level: "off", description: "mechanical lookup or trivial edit, no reasoning needed" },
  { level: "low", description: "simple, well-specified change; fix already identified" },
  { level: "medium", description: "normal multi-step implementation or verification" },
  { level: "high", description: "cross-file reasoning, subtle interactions, careful refactor" },
  { level: "xhigh", description: "architecture, design tradeoffs, consequential planning" },
];

const TIER_CRITERIA: Record<Tier, string> = {
  fast: "mechanical, read-heavy, bounded lookup, or a single-file change with a known fix — speed matters more than depth",
  coder: "standard implementation, editing, or verification with a clear spec — solid general coding",
  smart: "ambiguous design, cross-cutting refactor, consequential review or planning — depth matters more than speed",
};

const DISPATCH_CRITERIA: Record<DispatchKind, string> = {
  pane: "the parent should watch it run or needs the result in the same turn — uncertain or interactive work, or anything that may block on a question only answerable in a visible pane",
  background: "long, self-contained work whose result the parent can consume later — the parent keeps working while the task runs detached",
};
export type DispatchKind = "pane" | "background";

export interface RoutingVerdict {
  tier?: Tier;
  effort?: string;
  /** Dispatch decision (herdr only, and only when the caller asked for it). */
  dispatch?: DispatchKind;
  /** True when a verdict was produced within threshold (diagnostics only). */
  applied: boolean;
  reason?: string;
}

/**
 * Resolve the classifier model: explicit override (matched like the classifier
 * module — provider/id, or id suffix across providers) → first available
 * router classifier. Returns undefined when none resolve (fail-open).
 */
/** The classifier model object resolved for routing (full catalog entry —
 *  registry.classify validates its `type` field, so a {provider,id} stub
 *  would be rejected as "not a classifier model"). */
export async function resolveClassifierModel(
  ctx: ExtensionContext,
  override: string,
): Promise<{ provider: string; id: string; type: string } | undefined> {
  const registry = ctx.modelRegistry;
  if (override) {
    // Accept bare id ("combo/jev"), provider-qualified ("router/combo/jev" —
    // the pre-0.7 /config menu saved provider/id), or a provider-scoped id
    // that IS the id ("jev/jev-latest" under provider router). Try in order:
    // exact id, provider-stripped id, suffix match.
    const stripped = override.includes("/") ? override.slice(override.indexOf("/") + 1) : override;
    const direct = registry.findOfType("classifier", "router", override)
      ?? (stripped !== override ? registry.findOfType("classifier", "router", stripped) : undefined)
      ?? registry.getModelsOfType("classifier").find((m) => m.id === override || m.id.endsWith("/" + override) || m.id === stripped || m.id.endsWith("/" + stripped));
    if (direct) return direct as { provider: string; id: string; type: string };
  }
  const available = await registry.getAvailableOfType("classifier", "router");
  const first = available[0];
  return first ? (first as { provider: string; id: string; type: string }) : undefined;
}

/** Is this agent pinned by settings such that the classifier must not touch it? */
export function pinsFor(agent: AgentConfig, roles: RolesConfig): { models: boolean; thinking: boolean } {
  return {
    models: roles.agentModels[agent.name] !== undefined,
    thinking: roles.agentThinking[agent.name] !== undefined,
  };
}

/**
 * Ask Jev for {tier, effort} on one task. Returns undefined on any failure —
 * callers fall back to the agent's frontmatter defaults. Never throws.
 */
export async function classifyTask(
  ctx: ExtensionContext,
  settings: RoutingSettings,
  agent: AgentConfig,
  task: string,
  solutionSpace: string | undefined,
  roles: RolesConfig,
  opts: { askDispatch?: boolean; deadlineMs?: number } = {},
): Promise<RoutingVerdict | undefined> {
  if (settings.mode !== "classify") return undefined;
  const pins = pinsFor(agent, roles);
  // A fully pinned agent (agentModels) is user-owned — no call at all.
  if (pins.models) return { applied: false, reason: "pinned (agentModels)" };

  const model = await resolveClassifierModel(ctx, settings.model);
  if (process.env.CEULEN_ROUTING_DEBUG) process.stderr.write(`[routing] resolved=${model ? model.provider + "/" + model.id : "none"}\n`);
  if (!model) return { applied: false, reason: "no classifier model" };

  const chain = resolveAgentModelChain(agent, roles);
  const wantEffort = !pins.thinking;
  const wantTier = chain.unresolved.length === 0; // tier only refines a resolvable role setup
  const wantDispatch = opts.askDispatch === true;

  try {
    // Belt-and-braces deadline: routing is advisory, so NOTHING about it may
    // hang a dispatch. The systemone transport carries its own default
    // timeout, but a provider that ignores the signal (the transport
    // contract only says "never rejects") must not park the dispatch — RACE
    // the ask against a hard cap and fail open to the static chain (live
    // incident 2026-10-06: two dispatches stuck 8h on a silent endpoint).
    const deadlineMs = opts.deadlineMs ?? 45_000;
    const deadline = AbortSignal.timeout(deadlineMs);
    const timedOut = new Promise<{ __deadline: true }>((resolve) => {
      deadline.addEventListener("abort", () => resolve({ __deadline: true }), { once: true });
    });
    const result = (await Promise.race([
      ctx.modelRegistry.classify(
      model as never,
      {
        state: {
          agent: { name: agent.name, description: agent.description, defaultRole: agent.model ?? "(none)" },
          task: task.slice(0, 4000),
          ...(solutionSpace ? { solutionSpace } : {}),
        },
        questions: {
          // wantTier: an unresolvable chain (typo'd @alias) must fail loud on
          // its own error — a tier override would silently swap in the role
          // pools and hide the typo until routing is off.
          ...(wantTier
            ? { tier: { type: "choice", instructions: "Which model tier should serve this task?", criteria: TIER_CRITERIA } }
            : {}),
          ...(wantEffort
            ? {
                effort: {
                  type: "score",
                  instructions: "How much reasoning does this task need?",
                  criteria: EFFORT_LADDER.map((c) => `${c.level}: ${c.description}`),
                },
              }
            : {}),
          ...(wantDispatch
            ? {
                dispatch: {
                  type: "choice",
                  instructions: "Where should this task run? Prefer pane unless the task is clearly long-running and independent.",
                  criteria: DISPATCH_CRITERIA,
                },
              }
            : {}),
        },
      } as never,
        { signal: deadline } as never,
      ),
      timedOut,
    ])) as { __deadline?: true; stopReason?: string; errorMessage?: string; answers?: Record<string, unknown> };
    if (result.__deadline) {
      return { applied: false, reason: `classifier deadline (${deadlineMs}ms) — failing open to static chain` };
    }
    if (result.stopReason !== "stop" || !result.answers) {
      if (process.env.CEULEN_ROUTING_DEBUG) process.stderr.write(`[routing] stopReason=${result.stopReason} err=${result.errorMessage ?? "-"}\n`);
      return { applied: false, reason: `classifier ${result.stopReason ?? "no answers"}` };
    }

    const tierAnswer = result.answers.tier as { choice?: string; probabilities?: Record<string, number> } | undefined;
    let tier: Tier | undefined;
    if (wantTier && tierAnswer?.choice && (TIERS as readonly string[]).includes(tierAnswer.choice)) {
      // Gate on the CHOSEN label's own probability. A label the classifier did
      // not report (or a non-numeric / out-of-range value) means no usable
      // certainty → no tier, exactly like below-threshold (fail open).
      const prob = tierAnswer.probabilities?.[tierAnswer.choice];
      tier = typeof prob === "number" && Number.isFinite(prob) && prob >= 0 && prob <= 1 && prob >= settings.threshold
        ? (tierAnswer.choice as Tier)
        : undefined;
    }

    let effort: string | undefined;
    if (wantEffort) {
      const effortAnswer = result.answers.effort as { score?: number; confidence?: number } | undefined;
      if (effortAnswer && typeof effortAnswer.score === "number"
        && (effortAnswer.confidence === undefined || effortAnswer.confidence >= settings.threshold)) {
        const idx = Math.min(Math.max(Math.round(effortAnswer.score), 0), EFFORT_LADDER.length - 1);
        effort = EFFORT_LADDER[idx].level;
      }
    }

    let dispatch: DispatchKind | undefined;
    if (wantDispatch) {
      const dispatchAnswer = result.answers.dispatch as { choice?: string; probabilities?: Record<string, number> } | undefined;
      if (dispatchAnswer?.choice === "pane" || dispatchAnswer?.choice === "background") {
        // Gate on the CHOSEN label's own probability — a high-probability
        // rival must not clear the threshold for a low-confidence choice,
        // and a missing/out-of-range value fails open to the pane default
        // (same rule as the tier gate above).
        const prob = dispatchAnswer.probabilities?.[dispatchAnswer.choice];
        if (typeof prob === "number" && Number.isFinite(prob) && prob >= 0 && prob <= 1 && prob >= settings.threshold) {
          dispatch = dispatchAnswer.choice;
        }
      }
    }

    if (process.env.CEULEN_ROUTING_DEBUG) process.stderr.write(`[routing] answers=${JSON.stringify(result.answers).slice(0, 300)}\n`);
    if (!tier && !effort && !dispatch) return { applied: false, reason: "below threshold" };
    return { tier, effort, dispatch, applied: true };
  } catch (e) {
    if (process.env.CEULEN_ROUTING_DEBUG) process.stderr.write(`[routing] error: ${e instanceof Error ? e.message : String(e)}\n`);
    return { applied: false, reason: "classifier error" };
  }
}
