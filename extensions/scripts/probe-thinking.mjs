#!/usr/bin/env node
// probe-thinking.mjs — live status matrix of `reasoning_effort` acceptance per
// router route. What values does the router forward, and what does the UPSTREAM
// accept for each glm-5.3* route? Read-only side effects: probe requests cost a
// handful of tokens.
//
// Config resolution mirrors the router module: ROUTER_API_KEY env → auth.json
// `router.key`; baseUrl from GLOBAL settings.json `router.baseUrl` (or
// ROUTER_BASE_URL env). Prints a value × route matrix of HTTP status.
//
// Usage: node extensions/scripts/probe-thinking.mjs [pattern]
//   pattern — optional id substring filter (default "glm-5.3")

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const EFFORTS = ["none", "off", "minimal", "low", "medium", "high", "xhigh", "max", "(omitted)"];

function agentDir() {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function resolveConfig() {
  let baseUrl = process.env.ROUTER_BASE_URL || "";
  let key = process.env.ROUTER_API_KEY || "";
  if (!baseUrl || !key) {
    try {
      if (existsSync(join(agentDir(), "settings.json"))) {
        const settings = JSON.parse(readFileSync(join(agentDir(), "settings.json"), "utf8"));
        if (!baseUrl) baseUrl = settings?.router?.baseUrl || "";
      }
    } catch { /* settings unreadable → env fallback only */ }
    if (!key && existsSync(join(agentDir(), "auth.json"))) {
      try {
        const auth = JSON.parse(readFileSync(join(agentDir(), "auth.json"), "utf8"));
        if (!key) key = auth?.router?.key || "";
      } catch { /* ignore */ }
    }
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ""), key };
}

async function chat(baseUrl, key, model, effort) {
  const url = /\/v1\/?$/.test(baseUrl) ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;
  const body = { model, messages: [{ role: "user", content: "Reply with exactly: ok" }], max_tokens: 512 };
  if (effort !== "(omitted)") body.reasoning_effort = effort;
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    const ms = Date.now() - started;
    if (res.ok) {
      const json = await res.json().catch(() => null);
      const reasoning = json?.choices?.[0]?.message?.reasoning_content;
      const thinkLen = typeof reasoning === "string" ? reasoning.length : 0;
      return `200 (${ms}ms, thinking ${thinkLen ? `~${thinkLen}ch` : "absent"})`;
    }
    const text = (await res.text().catch(() => "")).slice(0, 90).replace(/\s+/g, " ");
    return `${res.status} ${text}`;
  } catch (e) {
    return `ERR ${e instanceof Error ? e.message.slice(0, 60) : String(e)}`;
  }
}

const { baseUrl, key } = resolveConfig();
if (!baseUrl || !key) {
  console.error("No router baseUrl/key resolved (ROUTER_BASE_URL/ROUTER_API_KEY env, or settings.json/auth.json).");
  process.exit(1);
}
const pattern = process.argv[2] || "glm-5.3";

// 1. Discover glm-5.3* models from /v1/models.
let ids = [];
try {
  const res = await fetch(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30_000) });
  const json = await res.json();
  ids = (json?.data ?? []).map((m) => m.id).filter((id) => id.toLowerCase().includes(pattern.toLowerCase()));
} catch (e) {
  console.error(`Model list failed: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
if (ids.length === 0) {
  console.error(`No catalog ids matching /${pattern}/.`);
  process.exit(1);
}
// Cap: 9 efforts × N routes; keep the matrix sane.
ids = ids.slice(0, 4);
console.log(`Router: ${baseUrl}\nRoutes (${ids.length}): ${ids.join(", ")}\n`);

// 2. Probe each effort value against each route.
const header = "effort".padEnd(12) + ids.map((id) => id.slice(0, 38).padEnd(40)).join("");
console.log(header);
console.log("-".repeat(header.length));
for (const effort of EFFORTS) {
  const cells = [];
  for (const id of ids) {
    process.stderr.write(`  probing ${effort} × ${id}...\r`);
    cells.push((await chat(baseUrl, key, id, effort)).slice(0, 38).padEnd(40));
  }
  process.stderr.write(" ".repeat(60) + "\r");
  console.log(effort.padEnd(12) + cells.join(""));
}
console.log("\nRead: 200 = accepted; 4xx = rejected (value unsupported on that upstream); ERR = transport.");
