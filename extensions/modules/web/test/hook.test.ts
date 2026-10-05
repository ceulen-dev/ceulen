/**
 * Unit tests for pi-web before_agent_start routing-guidance injection.
 *
 * The routing protocol should be injected ONLY when a web_* tool is active,
 * so sessions without pi-web (or recon agents with no extension tools) carry
 * zero overhead. Previously this guidance was forced always-on via the global
 * AGENTS.md; now it self-injects from this extension.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import piWebExtension from "../index";

// chai-compat helpers (assert-based)
function includes(haystack: unknown, needle: unknown): boolean {
  if (typeof haystack === "string") return haystack.includes(String(needle));
  if (Array.isArray(haystack)) return (haystack as unknown[]).some((v) => {
    if (typeof v === "string" && typeof needle === "string") return v.includes(needle);
    if (v === needle) return true;
    // chai's to.include on an array does DEEP membership for objects.
    if (v && needle && typeof v === "object" && typeof needle === "object") {
      try { assert.deepStrictEqual(v, needle); return true; } catch { return false; }
    }
    return false;
  });
  // chai's to.include on an OBJECT target: needle's properties are a subset.
  if (haystack && typeof haystack === "object" && needle && typeof needle === "object") {
    return deepIncludes(haystack, needle as Record<string, unknown>);
  }
  return false;
}
function lengthOf(v: unknown): number {
  if (Array.isArray(v)) return v.length;
  if (typeof v === "string") return v.length;
  if (v && typeof v === "object" && "length" in (v as Record<string, unknown>)) return Number((v as Record<string, unknown>).length);
  if (v && typeof v === "object" && "size" in (v as Record<string, unknown>)) return Number((v as Record<string, unknown>).size);
  throw new Error("lengthOf: value has no length/size");
}
/** Deep "includes" — every own key of `part` must exist on `obj` with a
 *  deep-equal value (chai's to.deep.include for object subjects). */
function deepIncludes(obj: unknown, part: Record<string, unknown>): boolean {
  if (Array.isArray(obj)) return includes(obj, part); // deep membership
  if (typeof obj !== "object" || obj === null) return false;
  return Object.entries(part).every(([k, v]) => {
    try { assert.deepStrictEqual((obj as Record<string, unknown>)[k], v); return true; } catch { return false; }
  });
}

function harness(activeTools: string[] = []) {
  const tools: Record<string, any> = {};
  const handlers: Record<string, Function[]> = {};
  const pi: any = {
    registerTool(tool: any) { tools[tool.name] = tool; },
    on(name: string, handler: Function) { (handlers[name] ??= []).push(handler); },
    getActiveTools: () => activeTools,
  };
  piWebExtension(pi);
  return { tools, handlers };
}

function callHook(handlers: Record<string, Function[]>, selectedTools: string[] | undefined) {
  return handlers.before_agent_start[0]({
    systemPrompt: "BASE",
    systemPromptOptions: { selectedTools },
  });
}

describe("pi-web before_agent_start routing guidance", () => {
  it("registers twelve web_* tools", () => {
    const { tools } = harness();
    const webTools = Object.keys(tools).filter((n) => n.startsWith("web_"));
    assert.equal(lengthOf(webTools), 12);
  });

  it("injects routing guidance when a web_* tool is active", async () => {
    const { handlers } = harness();
    const result = await callHook(handlers, ["read", "web_search"]);
    assert.ok(includes(result.systemPrompt, "BASE"));
    assert.ok(includes(result.systemPrompt, "Web Tool Routing (pi-web)"));
    assert.ok(includes(result.systemPrompt, "Firecrawl Search is weak on domain-specific queries"));
  });

  it("does not inject when no web_* tool is active", async () => {
    const { handlers } = harness();
    const result = await callHook(handlers, ["read", "bash", "grep"]);
    // No systemPrompt returned → undefined result keeps the prompt unchanged.
    assert.equal(result, undefined);
  });

  it("falls back to pi.getActiveTools() when selectedTools is undefined", async () => {
    const { handlers } = harness(["read", "web_search"]);
    const result = await callHook(handlers, undefined);
    assert.ok(includes(result.systemPrompt, "Web Tool Routing (pi-web)"));
  });

  it("does not inject when selectedTools is undefined and no web_* tool is active", async () => {
    const { handlers } = harness(["read", "bash"]);
    const result = await callHook(handlers, undefined);
    assert.equal(result, undefined);
  });
});
