// subagent module tests — routing precedence, timeout resolution, settings
// layering, and the module load contract (guarded-pi conflict guard covers
// tool-name collisions at the bundle level).

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveChildTimeouts, validateAgentTools, DENIED_CHILD_TOOLS } from "../lib/security.ts";
import { expandModelCandidates, resolveAgentModelChain, splitThinkingSuffix, type RolesConfig } from "../lib/roles.ts";
import { classifyTask, EFFORT_LADDER, DEFAULT_ROUTING, pinsFor, type RoutingSettings } from "../lib/routing.ts";
import type { AgentConfig } from "../lib/agents.ts";

// ── Timeout resolution (the hard-cap-off contract) ──────────────────────────

test("resolveChildTimeouts: hardTimeoutMins 0 = no cap (a live child is never hard-killed)", () => {
  const r = resolveChildTimeouts({ hardTimeoutMins: 0 });
  assert.equal(r.error, undefined);
  assert.ok(r.timeoutMs && r.timeoutMs > 0); // idle window still set (hang detector)
  assert.equal(r.hardTimeoutMs, undefined);
});

test("resolveChildTimeouts: unset hardTimeoutMins defaults to no cap", () => {
  const r = resolveChildTimeouts({});
  assert.equal(r.hardTimeoutMs, undefined);
});

test("resolveChildTimeouts: enabled cap is clamped up to the idle window", () => {
  const r = resolveChildTimeouts({ hardTimeoutMins: 5, requested: 10 * 60_000 });
  assert.equal(r.hardTimeoutMs, 10 * 60_000); // max(cap, idle)
  const r2 = resolveChildTimeouts({ hardTimeoutMins: 30 });
  assert.equal(r2.hardTimeoutMs, 30 * 60_000);
});

test("resolveChildTimeouts: idleTimeoutMins overrides the env-derived inactivity default", () => {
  // Default comes from PI_SUBAGENT_INACTIVITY_TIMEOUT_MINS (3 min unless overridden).
  const envMins = Number(process.env.PI_SUBAGENT_INACTIVITY_TIMEOUT_MINS ?? 3);
  const base = resolveChildTimeouts({});
  assert.equal(base.timeoutMs, envMins * 60_000);

  const r = resolveChildTimeouts({ idleTimeoutMins: 1 });
  assert.equal(r.error, undefined);
  assert.equal(r.timeoutMs, 60_000, "idleTimeoutMins:1 must win over the env-derived default");

  // 0/undefined = keep the current behaviour (env default).
  assert.equal(resolveChildTimeouts({ idleTimeoutMins: 0 }).timeoutMs, base.timeoutMs);
  assert.equal(resolveChildTimeouts({ idleTimeoutMins: undefined }).timeoutMs, base.timeoutMs);

  // Still a DEFAULT: explicit per-call / frontmatter timeouts take precedence.
  assert.equal(resolveChildTimeouts({ idleTimeoutMins: 1, requested: 5 * 60_000 }).timeoutMs, 5 * 60_000);
  assert.equal(resolveChildTimeouts({ idleTimeoutMins: 1, agentTimeoutMins: 2 }).timeoutMs, 2 * 60_000);
  // The hard cap is still clamped up to the (now shorter) idle window.
  assert.equal(resolveChildTimeouts({ idleTimeoutMins: 1, hardTimeoutMins: 30 }).hardTimeoutMs, 30 * 60_000);
});

// ── Role expansion (tier override mechanics) ────────────────────────────────

const ROLES: RolesConfig = {
  roles: {
    fast: ["a/one", "b/two"],
    coder: ["c/three"],
    smart: ["d/four:high"],
  },
  agentModels: {},
  agentThinking: {},
};

test("expandModelCandidates expands a tier chain with :level suffixes intact", () => {
  const e = expandModelCandidates(["@smart"], ROLES.roles);
  assert.deepEqual(e.candidates, ["d/four"]);
  assert.equal(e.thinkingByCandidate.get("d/four"), "high");
});

test("resolveAgentModelChain: agentModels pin replaces the chain entirely", () => {
  const agent = { name: "worker", model: "@coder" } as Pick<AgentConfig, "name" | "model" | "models">;
  const pinned: RolesConfig = { ...ROLES, agentModels: { worker: "@fast" } };
  const chain = resolveAgentModelChain(agent, pinned);
  assert.deepEqual(chain.candidates, ["a/one", "b/two"]);
  assert.equal(chain.overridden, true);
});

test("splitThinkingSuffix keeps openrouter :free ids intact", () => {
  assert.deepEqual(splitThinkingSuffix("openrouter/x/y:free"), { name: "openrouter/x/y:free" });
  assert.deepEqual(splitThinkingSuffix("d/four:high"), { name: "d/four", thinking: "high" });
});

// ── Routing pins (pins beat dynamic) ────────────────────────────────────────

const WORKER = { name: "worker", description: "implements", model: "@coder" } as AgentConfig;

test("pinsFor: agentModels pin disables both overrides; agentThinking pin effort only", () => {
  const pins = pinsFor(WORKER, { ...ROLES, agentModels: { worker: "@fast" } });
  assert.equal(pins.models, true);
  assert.equal(pins.thinking, false);
  const pins2 = pinsFor(WORKER, { ...ROLES, agentThinking: { worker: "low" } });
  assert.equal(pins2.models, false);
  assert.equal(pins2.thinking, true);
});

test("classifyTask: mode off never routes", async () => {
  const verdict = await classifyTask(
    {} as never,
    { ...DEFAULT_ROUTING, mode: "off" },
    WORKER, "do a thing", undefined, ROLES,
  );
  assert.equal(verdict, undefined);
});

test("classifyTask: agentModels-pinned agent skips the classifier call entirely", async () => {
  const calls: unknown[] = [];
  const ctx = {
    modelRegistry: {
      getAvailableOfType: async () => [{ provider: "router", id: "jev" }],
      classify: (...args: unknown[]) => { calls.push(args); throw new Error("must not be called"); },
    },
  } as never;
  const verdict = await classifyTask(
    ctx,
    { ...DEFAULT_ROUTING, mode: "classify" },
    WORKER, "do a thing", undefined,
    { ...ROLES, agentModels: { worker: "@fast" } },
  );
  assert.equal(verdict?.applied, false);
  assert.equal(calls.length, 0);
});

test("classifyTask: applies tier+effort when confidence clears the threshold", async () => {
  const ctx = {
    modelRegistry: {
      getAvailableOfType: async () => [{ provider: "router", id: "jev" }],
      classify: async () => ({
        stopReason: "stop",
        answers: {
          tier: { type: "choice", choice: "smart", probabilities: { smart: 0.9, fast: 0.05, coder: 0.05 }, confidence: 0.9 },
          effort: { type: "score", score: 3, confidence: 0.8 },
        },
      }),
    },
  } as never;
  const verdict = await classifyTask(ctx, { ...DEFAULT_ROUTING, mode: "classify" }, WORKER, "design a cache layer", undefined, ROLES);
  assert.equal(verdict?.applied, true);
  assert.equal(verdict?.tier, "smart");
  assert.equal(verdict?.effort, EFFORT_LADDER[3].level);
});

test("classifyTask: below-threshold tier fails open (no override)", async () => {
  const ctx = {
    modelRegistry: {
      getAvailableOfType: async () => [{ provider: "router", id: "jev" }],
      classify: async () => ({
        stopReason: "stop",
        answers: {
          tier: { type: "choice", choice: "fast", probabilities: { smart: 0.4, fast: 0.35, coder: 0.25 }, confidence: 0.4 },
        },
      }),
    },
  } as never;
  const verdict = await classifyTask(ctx, { ...DEFAULT_ROUTING, mode: "classify" }, WORKER, "tweak", undefined, ROLES);
  assert.equal(verdict?.applied, false);
  assert.equal(verdict?.tier, undefined);
});

test("classifyTask: tier gates on the winning label's probability, not the answer `confidence` field", async () => {
  // probabilities fast=0.72 clears threshold 0.6 even though `confidence`=0.57 (a separate
  // self-report) — tier applies. Inverse case: label probability 0.54 with confidence 0.9 → no tier.
  const ctx = (answers: unknown) => ({
    modelRegistry: {
      getAvailableOfType: async () => [{ provider: "router", id: "jev" }],
      classify: async () => ({ stopReason: "stop", answers }),
    },
  } as never);
  const applied = await classifyTask(
    ctx({ tier: { type: "choice", choice: "fast", probabilities: { fast: 0.72, coder: 0.28, smart: 0 }, confidence: 0.57 } }),
    { ...DEFAULT_ROUTING, mode: "classify" },
    WORKER, "t", undefined, ROLES,
  );
  assert.equal(applied?.tier, "fast", "winning-label probability 0.72 >= 0.6 must apply despite confidence 0.57");
  const rejected = await classifyTask(
    ctx({ tier: { type: "choice", choice: "smart", probabilities: { smart: 0.54, fast: 0.4, coder: 0.06 }, confidence: 0.9 } }),
    { ...DEFAULT_ROUTING, mode: "classify" },
    WORKER, "t", undefined, ROLES,
  );
  assert.equal(rejected?.tier, undefined, "label probability 0.54 < 0.6 must fail open even at confidence 0.9");
});

test("classifyTask: tier gates on the CHOSEN label's probability, not a rival's max", async () => {
  // choice 'fast' at 0.40 with a 0.90 rival: the old Math.max gate wrongly
  // applied the rival's certainty to 'fast' and cleared the threshold.
  const ctx = (answers: unknown) => ({
    modelRegistry: {
      getAvailableOfType: async () => [{ provider: "router", id: "jev" }],
      classify: async () => ({ stopReason: "stop", answers }),
    },
  } as never);
  const rival = await classifyTask(
    ctx({ tier: { type: "choice", choice: "fast", probabilities: { fast: 0.4, coder: 0.9 } } }),
    { ...DEFAULT_ROUTING, mode: "classify" },
    WORKER, "t", undefined, ROLES,
  );
  assert.equal(rival?.tier, undefined, "a 0.9 rival must not clear the threshold for a 0.4 choice");

  const own = await classifyTask(
    ctx({ tier: { type: "choice", choice: "fast", probabilities: { fast: 0.72, coder: 0.28 } } }),
    { ...DEFAULT_ROUTING, mode: "classify" },
    WORKER, "t", undefined, ROLES,
  );
  assert.equal(own?.tier, "fast", "the chosen label's own 0.72 clears it");

  // Missing / malformed probability for the chosen label → no tier (fail open).
  const absent = await classifyTask(
    ctx({ tier: { type: "choice", choice: "fast", probabilities: { coder: 0.95 } } }),
    { ...DEFAULT_ROUTING, mode: "classify" },
    WORKER, "t", undefined, ROLES,
  );
  assert.equal(absent?.tier, undefined, "unreported label probability = no verdict");
  const bogus = await classifyTask(
    ctx({ tier: { type: "choice", choice: "fast", probabilities: { fast: 7 } } }),
    { ...DEFAULT_ROUTING, mode: "classify" },
    WORKER, "t", undefined, ROLES,
  );
  assert.equal(bogus?.tier, undefined, "out-of-range probability is not certainty");
});

test("classifyTask: classifier error fails open", async () => {
  const ctx = {
    modelRegistry: {
      getAvailableOfType: async () => [{ provider: "router", id: "jev" }],
      classify: async () => ({ stopReason: "error", errorMessage: "down" }),
    },
  } as never;
  const verdict = await classifyTask(ctx, { ...DEFAULT_ROUTING, mode: "classify" }, WORKER, "t", undefined, ROLES);
  assert.equal(verdict?.applied, false);
});

// ── Bundled agents (five, no general-purpose) ───────────────────────────────

test("bundled agents dir ships exactly the five ceulen agents", async () => {
  const { readdirSync } = await import("node:fs");
  const dir = join(import.meta.dirname, "..", "agents");
  const names = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  assert.deepEqual(names, ["planner.md", "reviewer.md", "scout.md", "tester.md", "worker.md"]);
});

// ── Settings layering ───────────────────────────────────────────────────────

test("readSubagentSettings: global file layer wins over defaults; project overlay wins when trusted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ceulen-sub-"));
  try {
    const agentDir = join(dir, "agent");
    const proj = join(dir, "proj");
    mkdirSync(join(agentDir), { recursive: true });
    mkdirSync(join(proj, ".pi"), { recursive: true });
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ subagent: { hardTimeoutMins: 20 } }));
    writeFileSync(join(proj, ".pi", "settings.json"), JSON.stringify({ subagent: { hardTimeoutMins: 45, routing: { mode: "off" } } }));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const ctx = {
      cwd: proj,
      isProjectTrusted: () => true,
    } as never;
    const { readSubagentSettings: read } = await import("../lib/settings.ts");
    const effective = read(ctx);
    assert.equal(effective.hardTimeoutMins, 45); // project overlay wins
    assert.equal(effective.routing.mode, "off");
    const globalOnly = read({ cwd: proj, isProjectTrusted: () => false } as never);
    assert.equal(globalOnly.hardTimeoutMins, 20); // untrusted project ignored
    assert.equal(globalOnly.routing.mode, "classify"); // default
  } finally {
    delete process.env.PI_CODING_AGENT_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});


// ── Cold-start catalog retry cooldown (module scope, not per-invocation) ────

test("resolveModelWithColdStartRetry: one forced refresh per cooldown window, across invocations", async () => {
  const { resolveModelWithColdStartRetry, resetCatalogRefreshCooldown } = await import("../index.ts");
  let refreshes = 0;
  // Empty catalog = the cold-start miss; refresh counts forced network pulls.
  const ctx = {
    model: undefined,
    modelRegistry: {
      getAvailable: () => [],
      refresh: async () => { refreshes += 1; },
    },
  } as never;

  resetCatalogRefreshCooldown();
  await resolveModelWithColdStartRetry(ctx, ["router/zai/glm-5.3-flash"]);
  assert.equal(refreshes, 1, "first miss triggers the forced refresh");

  // The regression: a SECOND dispatch (its own execute() closure in production)
  // must NOT re-fire the refresh inside the cooldown window.
  await resolveModelWithColdStartRetry(ctx, ["router/zai/glm-5.3-flash"]);
  assert.equal(refreshes, 1, "cooldown must hold across invocations (module-scope state)");

  // After the cooldown is cleared, the refresh is allowed again.
  resetCatalogRefreshCooldown();
  await resolveModelWithColdStartRetry(ctx, ["router/zai/glm-5.3-flash"]);
  assert.equal(refreshes, 2, "cooldown reset allows the next forced refresh");
});

test("resolveModelWithColdStartRetry: a resolvable model short-circuits (no refresh)", async () => {
  const { resolveModelWithColdStartRetry, resetCatalogRefreshCooldown } = await import("../index.ts");
  resetCatalogRefreshCooldown();
  let refreshes = 0;
  const model = { provider: "router", id: "zai/glm-5.3-flash" };
  const ctx = {
    model: undefined,
    modelRegistry: {
      getAvailable: () => [model],
      refresh: async () => { refreshes += 1; },
    },
  } as never;
  const resolved = await resolveModelWithColdStartRetry(ctx, ["router/zai/glm-5.3-flash"]);
  assert.equal(resolved.model, model);
  assert.equal(refreshes, 0, "a hit must never pay a refresh");
});

// ── Unresolved @role fails loud (shared SDK + herdr resolution path) ────────

/** Fake-pi harness: registers the real module and drives `subagent.execute`,
 *  so the assertion covers the shared routedChain gate, not a re-implementation. */
async function dispatchHarness(agentsMd: Record<string, string>, roles: RolesConfig["roles"], herdrEnv = false) {
  const dir = mkdtempSync(join(tmpdir(), "ceulen-subagent-dispatch-"));
  const agentDir = join(dir, "agents");
  mkdirSync(agentDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = dir; // agent dir holds both agents/ and settings.json
  process.env.PI_SUBAGENT_HERDR = "off";
  if (herdrEnv) {
    // herdrActive requires the env marker AND a successful binary probe.
    process.env.HERDR_ENV = "1";
    process.env.HERDR_WORKSPACE_ID = "ws";
    const { herdrCli } = await import("../lib/herdr.ts");
    herdrCli.exec = async () => ({ code: 0, stdout: "herdr 1.0.0", stderr: "" });
  }
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ subagent: { roles, routing: { mode: "off" } } }));
  for (const [name, body] of Object.entries(agentsMd)) writeFileSync(join(agentDir, name), body);

  // index.ts is CJS-compiled by tsx (bundled extension) — `__dirname` must exist.
  (globalThis as Record<string, unknown>).__dirname = join(import.meta.dirname, "..");
  const { default: subagentModule } = await import("../index.ts");
  const tools = new Map<string, { execute: (...a: unknown[]) => Promise<any> }>();
  const hooks = new Map<string, ((...a: unknown[]) => unknown)[]>();
  const pi = {
    registerTool: (t: { name: string }) => tools.set(t.name, t as never),
    registerCommand: () => {}, registerMessageRenderer: () => {}, registerShortcut: () => {},
    on: (name: string, fn: (...a: unknown[]) => unknown) => {
      (hooks.get(name) ?? hooks.set(name, []).get(name)!).push(fn);
    },
    getAllTools: () => [{ name: "read" }],
    registerFlag: () => {}, getFlag: () => undefined,
    events: { emit: () => {}, on: () => () => {} },
    getSettings: () => ({}),
  };
  subagentModule(pi as never);
  // The parent model is deliberately DIFFERENT from the role-pool model: the
  // defect's signature is a child dispatched on "test/parent" because the
  // empty candidate list fell through to resolveModel's parent fallback.
  const parentModel = { provider: "test", id: "parent" };
  const roleModel = { provider: "test", id: "role" };
  const ctx = {
    cwd: dir, mode: "print", hasUI: false, isProjectTrusted: () => false,
    model: parentModel,
    modelRegistry: {
      getAvailable: () => [parentModel, roleModel], find: () => parentModel, refresh: async () => {},
      getAvailableOfType: async () => [], classify: async () => ({ stopReason: "error" }),
      runtime: { hasConfiguredAuth: () => true, streamSimple: async function* () {} }, authStorage: {},
    },
    ui: { notify: () => {} },
    sessionManager: { getBranch: () => [], getSessionFile: () => undefined },
  };
  for (const handler of hooks.get("session_start") ?? []) await handler({ reason: "start" }, ctx);
  const tool = tools.get("subagent")!;
  return {
    dispatch: (agent: string, extra: Record<string, unknown> = {}) =>
      tool.execute("tc", { agent, task: "say hi", agentScope: "user", runner: "sdk", ...extra }, undefined, undefined, ctx),
    cleanup: () => {
      delete process.env.PI_CODING_AGENT_DIR;
      delete process.env.HERDR_ENV;
      delete process.env.HERDR_WORKSPACE_ID;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("dispatch: a typo'd @role fails loud instead of silently using the parent model", async () => {
  const h = await dispatchHarness(
    {
      "typo.md": '---\nname: typo\ndescription: t\ntools: read\nmodel: "@smartt"\n---\nbody\n',
      "good.md": '---\nname: good\ndescription: g\ntools: read\nmodel: "@smart"\n---\nbody\n',
      // One unresolvable extra entry beside a resolvable chain stays a diagnostic.
      "partial.md": '---\nname: partial\ndescription: p\ntools: read\nmodels: ["@smart", "@nope"]\n---\nbody\n',
    },
    { fast: ["test/role"], coder: ["test/role"], smart: ["test/role"] },
  );
  try {
    const bad = await h.dispatch("typo");
    assert.equal(bad.isError, true, "a dispatch that resolves NOTHING must fail");
    assert.match(bad.content[0].text, /Unresolved model role\(s\): @smartt/);

    // A resolvable @role still dispatches — on the ROLE pool's model, never
    // the parent model the silent fallback would have swapped in.
    const ok = await h.dispatch("good");
    assert.equal(ok.details?.results?.[0]?.model, "test/role");
    assert.doesNotMatch(ok.content[0].text, /Unresolved model role/);

    // A resolvable chain plus one unknown extra role keeps working (the
    // unresolved entry is a diagnostic, not a dispatch failure).
    const partial = await h.dispatch("partial");
    assert.equal(partial.details?.results?.[0]?.model, "test/role");
    assert.doesNotMatch(partial.content[0].text, /Unresolved model role/);
  } finally {
    h.cleanup();
  }
});

test("dispatch: the herdr runner surfaces the SAME unresolved-@role failure", async () => {
  const h = await dispatchHarness(
    { "typo.md": '---\nname: typo\ndescription: t\ntools: read\nmodel: "@smartt"\n---\nbody\n' },
    { smart: ["test/role"] },
    true, // HERDR_ENV set + probe passes → prepareHerdrOne is the code path
  );
  try {
    // No explicit runner: auto-detection picks herdr. It must fail on the typo
    // BEFORE creating a pane (shared routedChain gate, not a second resolver).
    const res = await h.dispatch("typo", { runner: undefined });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Unresolved model role\(s\): @smartt/);
  } finally {
    h.cleanup();
  }
});

// ── Recursion guard ─────────────────────────────────────────────────────────

test("DENIED_CHILD_TOOLS strips subagent from inherited tool sets", () => {
  const result = validateAgentTools({ tools: ["read", "subagent", "grep", "bash"], availableTools: ["read", "subagent", "grep", "bash"] });
  assert.deepEqual(result.tools, ["read", "grep", "bash"]);
  assert.ok(DENIED_CHILD_TOOLS.has("subagent"));
});

// RoutingSettings shape sanity (import used, contract pinned)
test("DEFAULT_ROUTING ships classify-on with the documented threshold", () => {
  assert.equal(DEFAULT_ROUTING.mode, "classify");
  assert.equal(DEFAULT_ROUTING.threshold, 0.6);
  void (0 as unknown as RoutingSettings | null);
});

// ── Dispatch question (herdr pane vs detached background) ───────────────────

function dispatchCtx(answers: Record<string, unknown>, onQuestions?: (q: Record<string, unknown>) => void) {
  return {
    modelRegistry: {
      getAvailableOfType: async () => [{ provider: "router", id: "jev" }],
      classify: async (_model: unknown, payload: { questions: Record<string, unknown> }) => {
        onQuestions?.(payload.questions);
        return { stopReason: "stop", answers };
      },
    },
  } as never;
}

const TIER_AND_EFFORT = {
  tier: { type: "choice", choice: "fast", probabilities: { fast: 0.95 } },
  effort: { type: "score", score: 0, confidence: 0.9 },
};

test("classifyTask: the dispatch question is asked only when requested", async () => {
  let asked: Record<string, unknown> = {};
  const ctx = dispatchCtx(
    { ...TIER_AND_EFFORT, dispatch: { choice: "background", probabilities: { background: 0.9, pane: 0.1 } } },
    (q) => { asked = q; },
  );
  const without = await classifyTask(ctx, { ...DEFAULT_ROUTING, mode: "classify" }, WORKER, "do a thing", undefined, ROLES);
  assert.equal("dispatch" in asked, false, "no dispatch question when not requested");
  assert.equal(without?.dispatch, undefined);

  const withDispatch = await classifyTask(ctx, { ...DEFAULT_ROUTING, mode: "classify" }, WORKER, "do a thing", undefined, ROLES, { askDispatch: true });
  assert.equal("dispatch" in asked, true, "dispatch question asked on request");
  assert.equal(withDispatch?.dispatch, "background");
  assert.equal(withDispatch?.applied, true);
});

test("classifyTask: below-threshold dispatch stays pane while tier still applies", async () => {
  const ctx = dispatchCtx({
    tier: { type: "choice", choice: "fast", probabilities: { fast: 0.9 } },
    effort: { type: "score", score: 0, confidence: 0.9 },
    dispatch: { choice: "background", probabilities: { background: 0.4, pane: 0.35 } },
  });
  const verdict = await classifyTask(ctx, { ...DEFAULT_ROUTING, mode: "classify" }, WORKER, "tweak", undefined, ROLES, { askDispatch: true });
  assert.equal(verdict?.dispatch, undefined, "uncertain dispatch answers keep the pane default");
  assert.equal(verdict?.tier, "fast");
  assert.equal(verdict?.applied, true);
});

test("classifyTask: a confident dispatch answer alone counts as applied", async () => {
  const ctx = dispatchCtx({
    tier: { type: "choice", choice: "fast", probabilities: { fast: 0.2 } },
    effort: { type: "score", score: 3, confidence: 0.1 },
    dispatch: { choice: "background", probabilities: { background: 0.95, pane: 0.05 } },
  });
  const verdict = await classifyTask(ctx, { ...DEFAULT_ROUTING, mode: "classify" }, WORKER, "long audit", undefined, ROLES, { askDispatch: true });
  assert.equal(verdict?.tier, undefined);
  assert.equal(verdict?.effort, undefined);
  assert.equal(verdict?.dispatch, "background");
  assert.equal(verdict?.applied, true, "dispatch alone can carry the verdict");
});

test("classifyTask: dispatch gates on the CHOSEN label's own probability — a high rival must not clear it", async () => {
  // Live-found defect (reviewer 2026-10-06): the old gate took Math.max over
  // ALL probabilities, so choice "background" at 0.4 applied because rival
  // "pane" scored 0.65 — silently detaching a task the classifier wanted in
  // a pane. Mirrors the tier question's chosen-label rule.
  const rival = dispatchCtx({
    ...TIER_AND_EFFORT,
    dispatch: { choice: "background", probabilities: { background: 0.4, pane: 0.65 } },
  });
  const v1 = await classifyTask(rival, { ...DEFAULT_ROUTING, mode: "classify" }, WORKER, "long job", undefined, ROLES, { askDispatch: true });
  assert.equal(v1?.dispatch, undefined, "rival probability must not clear the threshold for the choice");

  const confident = dispatchCtx({
    ...TIER_AND_EFFORT,
    dispatch: { choice: "background", probabilities: { background: 0.72, pane: 0.28 } },
  });
  const v2 = await classifyTask(confident, { ...DEFAULT_ROUTING, mode: "classify" }, WORKER, "long job", undefined, ROLES, { askDispatch: true });
  assert.equal(v2?.dispatch, "background");

  // Out-of-range / bogus probabilities fail open (no dispatch override).
  const bogus = dispatchCtx({
    ...TIER_AND_EFFORT,
    dispatch: { choice: "background", probabilities: { background: 7 } },
  });
  const v3 = await classifyTask(bogus, { ...DEFAULT_ROUTING, mode: "classify" }, WORKER, "long job", undefined, ROLES, { askDispatch: true });
  assert.equal(v3?.dispatch, undefined, "out-of-range probability fails open to the pane default");
});

test("classifyTask: a never-resolving classify hits the deadline and fails open to the static chain", async () => {
  // The 2026-10-06 live incident class: a silent endpoint parked the dispatch
  // forever. The deadline race must return a fail-open verdict instead.
  const ctx = {
    modelRegistry: {
      getAvailableOfType: async () => [{ provider: "router", id: "jev" }],
      classify: () => new Promise(() => {}),
    },
  } as never;
  const t0 = Date.now();
  const verdict = await classifyTask(ctx, { ...DEFAULT_ROUTING, mode: "classify" }, WORKER, "anything", undefined, ROLES, { deadlineMs: 100 });
  const ms = Date.now() - t0;
  assert.ok(ms < 2_000, `deadline raced (${ms}ms) instead of hanging`);
  assert.equal(verdict?.applied, false, "deadline expiry fails open");
  assert.match(verdict?.reason ?? "", /deadline/);
});

test("classifyTask: an unresolvable chain suppresses the tier question (typo fails loud, not papered over)", async () => {
  let asked: Record<string, unknown> = {};
  const ctx = dispatchCtx(
    { effort: { type: "score", score: 3, confidence: 0.9 }, tier: { choice: "smart", probabilities: { smart: 0.99 } } },
    (q) => { asked = q; },
  );
  const broken = { name: "worker", description: "x", model: "@smartt" } as AgentConfig;
  const verdict = await classifyTask(ctx, { ...DEFAULT_ROUTING, mode: "classify" }, broken, "do a thing", undefined, ROLES);
  assert.equal("tier" in asked, false, "tier question suppressed for an unresolved chain");
  assert.equal("effort" in asked, true, "effort still routes");
  assert.equal(verdict?.tier, undefined);
  assert.equal(verdict?.effort, EFFORT_LADDER[3].level);
});
