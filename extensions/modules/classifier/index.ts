/**
 * classifier — System One decision models (TypeSafe Jev) for ceulen.
 *
 * Ported from @bacnh85/pi-classifier 0.2.3 (extensions/index.js), rewired to
 * the MODEL REGISTRY: the router provider (lib/provider.ts) discovers decision
 * models on /v1/systemone/models and carries the System One classifier impl,
 * so this module has no endpoint, no API-key resolution, and no wire code —
 * every ask goes through ctx.modelRegistry.classify() (request-time auth via
 * the shared ROUTER credential, never rejects).
 *
 * 1. `classify` tool: the agent sends {state, questions}, gets typed answers.
 * 2. Bash verdict hook: classifies each bash command (reversible + serves
 *    the task) and AUDITS the verdict to ~/.pi/agent/classifier.log. Static
 *    RISKY list first; never blocks; every failure falls through safely.
 *    NOTE: pi 1.0.0 core has NO built-in per-call approval prompt
 *    (docs/security.md) and `tool_call` can only block, never approve — so
 *    this hook is an observer/auditor, not a permission gate. "enforce" vs
 *    "observe" only changes whether confident verdicts get a visible
 *    annotation in the transcript; neither mode changes execution.
 *
 * Config: `classifier` section of ~/.pi/agent/settings.json (global only —
 * see lib/settings.ts). /config owns the rows (Model tab → Classifier).
 * pi-classifier's planGate is NOT ported and NOT consumed by the plan module:
 * pi 1.0.0's `tool_call` hook can only block, never approve, so a gate could
 * only have trimmed plan-mode confirm prompts (source preserved in
 * pi-extensions git history).
 */

import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getClassifierSettings } from "./lib/settings.js";
import { setClassifierRegistry } from "./configPanel.js";
import { readDisabledTools } from "../../lib/tools.js";

// ── Risk gate (static, before Jev ever sees a command) ──────────────────────

const RISKY = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)/, // rm -rf
  /\bsudo\b/, /\bdoas\b/,
  /\bgit\s+push\b[^|;&]*--force/, /\bgit\s+push\s+-f\b/, /\bgit\s+reset\s+--hard\b/,
  /curl[^|;&]*\|\s*(ba)?sh/, /wget[^|;&]*\|\s*(ba)?sh/, // pipe-to-shell
  /\b(npm|pnpm|yarn|bun)\s+publish\b/, /\bgh\s+release\s+(create|upload)\b/,
  /\bterraform\s+(apply|destroy)\b/, /\bkubectl\s+(delete|apply)\b/,
  /(^|\s)~?\/?\.?(ssh|aws|gnupg|kube)(\/|$)/, /id_rsa|\.pem\b|credentials\b/i,
];

/** True when the command matches the static risk list — never sent to Jev.
 *  Exported for tests. Intentionally shallow: a new RISKY shape = new entry. */
export function isRisky(command: string): boolean {
  return RISKY.some((re) => re.test(command));
}

/** Split a compound command into top-level segments the RISKY check can see.
 *  Split on operators only — a separator inside quotes can only ADD a prompt,
 *  never hide a command. Exported for tests. */
export function segments(command: string): string[] {
  return String(command).split(/&&|\|\||[;|&]|`|\$\(/).map((s) => s.trim()).filter(Boolean);
}

/** Read a probability from a Jev answer. The registry path returns
 *  {type:"bool", probability}; raw wire {noul} is tolerated. Malformed/
 *  missing/out-of-range → NaN → fail-safe. Exported for tests. */
export function noul(answers: unknown, id: string): number {
  const a = (answers as Record<string, unknown> | undefined)?.[id];
  const v = a && typeof a === "object" ? (a as Record<string, unknown>).probability ?? (a as Record<string, unknown>).noul : a;
  return typeof v === "number" && v >= 0 && v <= 1 ? v : NaN;
}

/** LRU verdict cache — repeated `bun test` shouldn't re-pay Jev every time.
 *  ponytail: insertion-order map, cap 100. Exported for tests. */
export function createVerdictCache(cap = 100) {
  const m = new Map<string, unknown>();
  return {
    get(k: string): unknown {
      if (!m.has(k)) return undefined;
      const v = m.get(k);
      m.delete(k);
      m.set(k, v!); // refresh recency
      return v;
    },
    set(k: string, v: unknown): void {
      if (m.has(k)) m.delete(k);
      m.set(k, v);
      if (m.size > cap) m.delete(m.keys().next().value!);
    },
  };
}

/** Audit line per decision. Best-effort: never throws into the tool path.
 *  0600 — the log records full bash commands and task text, same
 *  permission discipline as pi's settings/auth files. */
function audit(entry: Record<string, unknown>): Promise<void> {
  try {
    const dir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
    // ponytail: async write so the tool_call hot path never blocks. Never rejects.
    return mkdir(dir, { recursive: true })
      .then(() => appendFile(join(dir, "classifier.log"), JSON.stringify({ ts: Date.now(), pid: process.pid, ...entry }) + "\n", { mode: 0o600 }))
      .catch(() => {});
  } catch {
    return Promise.resolve(); // logging must never break the command
  }
}

/** Ask Jev via the registry: resolve the router decision model (settings
 *  override → first available) and classify. Returns answers, throws with a
 *  remediation hint when nothing is configured — callers fail safe around it. */
/** Cooldown for the cold-start forced refresh: a persistently unresolvable
 *  model (endpoint down, no creds) must not make every bash command pay a
 *  network attempt. Recovery still works — the next miss after the window
 *  retries. */
let lastForcedRefresh = 0;

/** Test hook: clear the cold-start cooldown (module state outlives a test). */
export function resetClassifierRefreshCooldown(): void {
  lastForcedRefresh = 0;
}

async function askJev(ctx: ExtensionContext, state: Record<string, unknown>, questions: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const resolve = async () => {
    const s = getClassifierSettings();
    let model = s.model ? ctx.modelRegistry.findOfType("classifier", "router", s.model) : undefined;
    if (!model && s.model) {
      // Settings may name a model from another provider (openrouter ~typesafe/…): match by id suffix.
      model = ctx.modelRegistry.getModelsOfType("classifier").find((m) => m.id === s.model || m.id.endsWith("/" + s.model));
    }
    if (!model) {
      const available = await ctx.modelRegistry.getAvailableOfType("classifier", "router");
      model = available[0];
    }
    return model;
  };
  let model = await resolve();
  if (!model) {
    // Cold start: the router catalog's network pull races session startup, so
    // the restored snapshot can still be chat-only. One forced pull + retry;
    // the regular path is untouched (this only runs on a resolution miss).
    if (Date.now() - lastForcedRefresh > 60_000) {
      lastForcedRefresh = Date.now();
      try {
        await ctx.modelRegistry.refresh({ providers: ["router"], force: true });
      } catch {
        /* offline/endpoint down — the remediation error below still fires */
      }
      model = await resolve();
    }
  }
  if (!model) {
    throw new Error("no classifier model — configure the router provider (router.baseUrl + /login router) or set classifier.model");
  }
  const result = await ctx.modelRegistry.classify(model, { state, questions } as Parameters<typeof ctx.modelRegistry.classify>[1], { signal });
  if (result.stopReason !== "stop") throw new Error(result.errorMessage ?? `classifier failed (${result.stopReason})`);
  return result.answers as unknown as Record<string, unknown>;
}

export default function (pi: ExtensionAPI) {
  // The /config contribution reads discovered decision models at open time;
  // config factories get no ctx, so the module stashes the live registry
  // here (the panel always opens after a session exists). Cleared on shutdown
  // so a stale registry never survives session replacement (router's pattern).
  pi.on("session_start", (_event, ctx) => {
    setClassifierRegistry(ctx.modelRegistry);
  });
  pi.on("session_shutdown", () => {
    setClassifierRegistry(undefined);
  });

  // ── 1. classify tool ────────────────────────────────────────────────────
  const stateSchema = Type.Any({ description: "Everything Jev should judge: transcript, records, policy — as JSON." });
  const questionsSchema = Type.Array(
    Type.Object({
      id: Type.String({ description: "Answer key, e.g. 'is_urgent'" }),
      type: Type.Union([Type.Literal("noul"), Type.Literal("choice"), Type.Literal("score")]),
      instructions: Type.String({ description: "The question about the state." }),
      criteria: Type.Optional(Type.Any({ description: "choice: {option: description} · score: [levels] · noul: {yes,no}" })),
    }),
    { description: "One entry per independent judgment. They run in parallel and cannot see each other's answers." },
  );

  pi.registerTool({
    name: "classify",
    label: "Classify",
    // Per-tool kill-switch (ceulen.disabledTools / /config tool rows).
    defaultActive: !readDisabledTools().has("classify"),
    description:
      "Ask a System One decision model (TypeSafe Jev) typed questions about a state and get calibrated answers: " +
      "noul (probability of yes), choice (option + per-option probabilities + confidence), score (weighted position + confidence). " +
      "Use for routing, verification, and gating decisions where a predictable typed answer beats generated prose. " +
      "Not for open-ended questions — decisions only, no explanations.",
    parameters: Type.Object({ state: stateSchema, questions: questionsSchema }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const qs: Record<string, unknown> = {};
      for (const q of params.questions ?? []) {
        let criteria = q.criteria as unknown;
        // score criteria must be a LIST upstream — an object-shaped criteria
        // (easy to produce from a JSON-schema mindset) gets 422 from Jev, so
        // coerce {"0":"low",...} to ["low",...] before sending.
        if (q.type === "score" && criteria && !Array.isArray(criteria) && typeof criteria === "object") {
          criteria = Object.keys(criteria as Record<string, unknown>).sort((a, b) => Number(a) - Number(b)).map((k) => (criteria as Record<string, unknown>)[k]);
        }
        qs[q.id] = { type: q.type, instructions: q.instructions, ...(criteria !== undefined ? { criteria } : {}) };
      }
      const answers = await askJev(ctx, params.state as Record<string, unknown>, qs, signal ?? undefined);
      return {
        content: [{ type: "text", text: JSON.stringify(answers, null, 2) }],
        details: { answers },
      };
    },
  });

  // ── 2. permission auto-approve hook (ported from pi-classifier) ─────────
  let lastTask = "";
  pi.on("message_end", (event) => {
    const msg = event.message;
    if (msg?.role !== "user") return;
    if (typeof msg.content === "string") lastTask = msg.content.slice(0, 4000);
    // Array-shaped content: join the text parts (images etc. contribute nothing).
    else if (Array.isArray(msg.content)) {
      lastTask = (msg.content as { type?: string; text?: unknown }[])
        .filter((p) => p?.type === "text" && typeof p.text === "string")
        .map((p) => p.text as string)
        .join("\n")
        .slice(0, 4000);
    }
  });

  const cache = createVerdictCache();

  // Failure circuit-breaker (advisor's MAX_CONSECUTIVE_FAILURES precedent):
  // the bash hot path must never pay the classify deadline per command. With
  // the transport's 30s deadline, a cataloged-but-dead endpoint would stall
  // every unique non-risky command ~30s — repeatedly, buying nothing (the
  // verdict never gates execution). After 3 consecutive failures the hook
  // fails open instantly for CLASSIFIER_PAUSE_COOLDOWN_MS; a successful
  // verdict or a settings change re-arms immediately.
  let consecutiveFailures = 0;
  let pausedUntil = 0;
  let pausedSettingsRef = "";
  const CLASSIFIER_PAUSE_AFTER = 3;
  const CLASSIFIER_PAUSE_COOLDOWN_MS = 5 * 60_000;
  // The bash hot path's OWN wait budget. The verdict is annotation-only in
  // pi 1.0.0 (no approval prompt to skip), so nothing justifies parking a
  // tool call on a slow Jev: a verdict that misses this budget reads as
  // "no verdict" (fail open to the normal prompt, audited). The 30s
  // transport deadline stays as the hard backstop; the circuit breaker
  // above then stops repeated retries.
  const CLASSIFIER_HOOK_BUDGET_MS = 2_500;

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;
    const command = String(event.input?.command || "");
    if (!command) return undefined;

    const s = getClassifierSettings();
    if (!s.permission.enabled) return undefined;

    // Circuit open → instant fail-open (no network attempt). A changed
    // settings object re-arms at once: the operator switching the classifier
    // model mid-pause should not wait out the cooldown.
    const settingsRef = JSON.stringify([s.model, s.permission.enabled, s.permission.mode, s.permission.threshold]);
    if (settingsRef !== pausedSettingsRef) {
      pausedSettingsRef = settingsRef;
      if (consecutiveFailures >= CLASSIFIER_PAUSE_AFTER) consecutiveFailures = 0; // manual remediation
    }
    // Circuit open? Instant fail-open. Else, if the pause window has ELAPSED
    // (pausedUntil > 0 — 0 means "never paused", which must not reset the
    // counter), close the circuit and retry.
    const paused = consecutiveFailures >= CLASSIFIER_PAUSE_AFTER;
    if (paused && Date.now() < pausedUntil) return undefined;
    if (paused && pausedUntil > 0 && Date.now() >= pausedUntil) {
      consecutiveFailures = 0; // cooldown elapsed → retry
      pausedUntil = 0;
    }

    // static list first — credential-touching / irreversible commands never
    // reach Jev and never leave the normal prompt
    if (segments(command).some(isRisky)) return undefined;

    const cacheKey = `${command}\u0000${ctx.cwd}\u0000${(lastTask || "").slice(0, 200)}`;
    const cached = cache.get(cacheKey) as { approve: boolean; reversible: number; serves_task: number } | undefined;

    const decide = async () => {
      const s = getClassifierSettings();
      const state: Record<string, unknown> = {
        command,
        project_path: ctx.cwd,
        ...(lastTask ? { task: lastTask } : {}),
      };
      const questions: Record<string, unknown> = {
        reversible: { type: "bool", instructions: "Can this shell command be undone — its effects reversed or discarded without lasting harm?" },
        ...(state.task
          ? {
              serves_task: {
                type: "bool",
                instructions: "Does this command plausibly serve the task the user asked for?",
                criteria: { yes: "A reasonable step toward the user's stated task.", no: "Unrelated to the task, or only a step the task never needed." },
              },
            }
          : {}),
      };
      const started = Date.now();
      try {
        const answers = await askJev(ctx, state, questions);
        consecutiveFailures = 0;
        const rev = noul(answers, "reversible");
        const serves = state.task ? noul(answers, "serves_task") : rev; // no task → reversibility only
        const ok = rev >= s.permission.threshold && serves >= s.permission.threshold;
        const decision = { approve: ok, reversible: rev, serves_task: serves };
        cache.set(cacheKey, decision);
        await audit({ command, ...decision, ms: Date.now() - started, model: s.model || "(auto)" });
        return decision;
      } catch (e) {
        consecutiveFailures++;
        if (consecutiveFailures >= CLASSIFIER_PAUSE_AFTER) {
          pausedUntil = Date.now() + CLASSIFIER_PAUSE_COOLDOWN_MS;
          await audit({ command, pause: true, failures: consecutiveFailures, cooldown_ms: CLASSIFIER_PAUSE_COOLDOWN_MS });
        }
        await audit({ command, error: String(e instanceof Error ? e.message : e), ms: Date.now() - started, model: s.model || "(auto)" });
        return null; // fail-safe: fall back to the normal prompt
      }
    };

    // Race the verdict against the hook budget — pi awaits this handler
    // before executing bash, so the budget (not the transport deadline) is
    // what the user feels. A late verdict is discarded (no cache poison).
    let decision: { approve: boolean; reversible: number; serves_task: number } | null | undefined = cached;
    if (decision === undefined) {
      const budget = AbortSignal.timeout(CLASSIFIER_HOOK_BUDGET_MS);
      decision = await Promise.race([
        decide(),
        new Promise<null>((resolve) => budget.addEventListener("abort", () => resolve(null), { once: true })),
      ]);
    }

    // Both modes only annotate; neither changes execution (pi 1.0.0 has no
    // approval prompt for tool_call to skip — see module docstring). Enforce
    // surfaces confident verdicts in the transcript so a human reviewing the
    // session sees the classifier vouched for the command; observe stays
    // log-only. NEVER blocks, NEVER denies.
    if (s.permission.mode === "enforce" && decision?.approve) {
      try {
        ctx.ui.notify(`classifier verdict: safe (${command.slice(0, 80)})`, "info");
      } catch {
        /* non-tui */
      }
    }
    return undefined;
  });
}
