import assert from "node:assert/strict";
import { test } from "node:test";
import { guarded } from "../../../index.ts";

// Minimal ExtensionAPI stub — only the register* surface the guard wraps.
function makePi() {
  const calls: { kind: string; name: string }[] = [];
  const rec = (kind: string) => (first: { name?: string } | string) => {
    calls.push({ kind, name: typeof first === "string" ? first : first.name! });
  };
  return {
    calls,
    pi: {
      registerCommand: rec("command"),
      registerTool: rec("tool"),
      registerFlag: rec("flag"),
      registerShortcut: rec("shortcut"),
      registerMessageRenderer: rec("renderer"),
      registerEntryRenderer: rec("entry-renderer"),
      registerProvider: rec("provider"),
    } as never,
  };
}

test("cross-module claim of the same name throws naming both modules", () => {
  const { pi } = makePi();
  const owner = new Map<string, string>();
  guarded(pi, "router", owner).registerCommand("usage-detail", {} as never);
  assert.throws(
    () => guarded(pi, "usage", owner).registerCommand("usage-detail", {} as never),
    /module "usage" re-registered command:usage-detail \(already owned by "router"\)/,
  );
});

test("same-module re-claim passes — router's runtime provider refresh pattern", () => {
  const { pi } = makePi();
  const owner = new Map<string, string>();
  const g = guarded(pi, "router", owner);
  g.registerProvider("router" as never);
  g.registerProvider("router" as never); // settings reload re-registers the provider
  g.registerCommand("router-status", {} as never);
  g.registerCommand("router-status", {} as never); // harmless re-claim
  assert.deepEqual(owner.get("provider:router"), "router");
});

test("different names from different modules coexist; ownership never transfers", () => {
  const { pi } = makePi();
  const owner = new Map<string, string>();
  guarded(pi, "router", owner).registerCommand("router-status", {} as never);
  guarded(pi, "usage", owner).registerCommand("usage", {} as never);
  guarded(pi, "usage", owner).registerMessageRenderer("ceulen-usage-context", (() => {}) as never);
  assert.equal(owner.get("command:router-status"), "router");
  assert.equal(owner.get("command:usage"), "usage");
  assert.equal(owner.get("renderer:ceulen-usage-context"), "usage");
});

test("the config module owns command:config; another module claiming it throws", () => {
  const { pi } = makePi();
  const owner = new Map<string, string>();
  guarded(pi, "config", owner).registerCommand("config", {} as never);
  assert.equal(owner.get("command:config"), "config");
  assert.throws(
    () => guarded(pi, "router", owner).registerCommand("config", {} as never),
    /module "router" re-registered command:config \(already owned by "config"\)/,
  );
});

test("claims pass through to the underlying pi API", () => {
  const { pi, calls } = makePi();
  const owner = new Map<string, string>();
  guarded(pi, "usage", owner).registerCommand("usage", {} as never);
  guarded(pi, "usage", owner).registerProvider({ name: "router" } as never);
  assert.deepEqual(calls, [
    { kind: "command", name: "usage" },
    { kind: "provider", name: "router" },
  ]);
});
