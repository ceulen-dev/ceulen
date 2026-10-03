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
