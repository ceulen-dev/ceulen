import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import uxExtension, {
  buildUxGroups,
  parseUxCommand,
  resolveSessionMode,
  readDefaultMode,
  readQuietStartup,
  uxConfig,
  writeDefaultMode,
} from "../index.ts";

/* Untyped harness stub: only the API surface the module actually touches.
 * (Kept loose on purpose — pi's SDK types require a full context object.) */
function createPiHarness() {
  const events = new Map();
  const commands = new Map();
  const tools = new Map();
  const appendedEntries = [];
  const discoverResults = [];

  const pi = {
    on(eventName, handler) {
      if (eventName === "resources_discover") discoverResults.push(handler);
      events.set(eventName, handler);
    },
    registerCommand(name, options) {
      commands.set(name, options);
    },
    registerTool(definition) {
      tools.set(definition.name, definition);
    },
    appendEntry(customType, data) {
      appendedEntries.push({ customType, data });
    },
    sendUserMessage() {},
  };

  uxExtension(pi);
  return { events, commands, tools, appendedEntries, discoverResults };
}

function createCommandContext(overrides = {}) {
  return {
    isIdle: () => true,
    sessionManager: { getEntries: () => [] },
    ui: { notify() {} },
    ...overrides,
  };
}

function withTempConfig(fn) {
  const tempConfigHome = mkdtempSync(join(tmpdir(), "ux-test-"));
  const previousXdg = process.env.XDG_CONFIG_HOME;
  const previousDefault = process.env.PI_UX_DEFAULT_MODE;
  const previousQuiet = process.env.PI_UX_QUIET_STARTUP;
  process.env.XDG_CONFIG_HOME = tempConfigHome;
  delete process.env.PI_UX_DEFAULT_MODE;
  delete process.env.PI_UX_QUIET_STARTUP;

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
      if (previousDefault === undefined) delete process.env.PI_UX_DEFAULT_MODE;
      else process.env.PI_UX_DEFAULT_MODE = previousDefault;
      if (previousQuiet === undefined) delete process.env.PI_UX_QUIET_STARTUP;
      else process.env.PI_UX_QUIET_STARTUP = previousQuiet;
      rmSync(tempConfigHome, { recursive: true, force: true });
    });
}

test("extension registers the /ux command and ux_audit tool, and NO status bar", () => {
  const { commands, tools, events } = createPiHarness();
  assert.deepEqual([...commands.keys()], ["ux"]);
  assert.deepEqual([...tools.keys()], ["ux_audit"]);
  // No status bar: no agent_start/agent_end sync handlers exist to draw one.
  assert.equal(events.has("agent_start"), false, "no agent_start handler (status-bar only)");
  assert.equal(events.has("agent_end"), false, "no agent_end handler (status-bar only)");
});

test("ux_audit is registered default-active unless ceulen.disabledTools lists it", () => {
  const active = createPiHarness();
  assert.equal(active.tools.get("ux_audit").defaultActive, true);
});

test("ux_audit parameter schema has the expected shape", () => {
  const { tools } = createPiHarness();
  const params = tools.get("ux_audit").parameters;
  assert.equal(params.type, "object");
  assert.ok(params.properties.css, "missing css property");
  assert.equal(params.properties.css.type, "string");
  assert.ok(params.properties.pairs, "missing pairs property");
  assert.equal(params.properties.pairs.type, "array");
  assert.ok(params.properties.pairs.items?.properties?.fg, "missing pairs.items.properties.fg");
  assert.ok(params.properties.pairs.items?.properties?.bg, "missing pairs.items.properties.bg");
});

test("ux_audit tool reports a clean pass on token-compliant CSS", async () => withTempConfig(async () => {
  const { tools } = createPiHarness();
  const css = `
    :root { --accent: #0066ff; --text: #111; --bg: #fff; --elev: 0 2px 8px rgba(0,0,0,0.08); }
    .card { color: var(--text); background: var(--bg); box-shadow: var(--elev); padding: 8px; }
    button { color: var(--accent); }
    button:focus-visible { outline: 2px solid var(--accent); }
    button:disabled { opacity: 0.5; }
  `;
  const out = await tools.get("ux_audit").execute(
    "id",
    { css, pairs: [{ fg: "#111", bg: "#fff", label: "body", min: 4.5 }] },
    undefined, undefined, { cwd: "." },
  );
  assert.match(out.content[0].text, /UX AUDIT PASSED/);
  assert.equal(out.details.pass, true);
}));

test("ux_audit tool reports a fail on hardcoded hex + missing states", async () => withTempConfig(async () => {
  const { tools } = createPiHarness();
  const css = `:root { --accent: #0066ff; } .card { color: #ff0000; } button { font-weight: bold; }`;
  const out = await tools.get("ux_audit").execute("id", { css, pairs: [] }, undefined, undefined, { cwd: "." });
  assert.match(out.content[0].text, /UX AUDIT FAILED/);
  assert.equal(out.details.pass, false);
  assert.match(out.content[0].text, /hardcoded hex/);
  assert.match(out.content[0].text, /focus-visible/i);
}));

test("ux_audit tool renders 'n/a' for an invalid colour pair", async () => withTempConfig(async () => {
  const { tools } = createPiHarness();
  const out = await tools.get("ux_audit").execute(
    "id",
    { css: "/* pair gate only */ .x { color: #111; }", pairs: [{ fg: "not-a-color", bg: "#fff", label: "bad", min: 4.5 }] },
    undefined, undefined, { cwd: "." },
  );
  assert.match(out.content[0].text, /UX AUDIT FAILED/);
  assert.match(out.content[0].text, /bad: n\/a/);
}));

test("ux_audit tool returns a formatted error for an unreadable path instead of throwing", async () => withTempConfig(async () => {
  const { tools } = createPiHarness();
  const out = await tools.get("ux_audit").execute(
    "id",
    { path: "/nonexistent/definitely-missing.css", pairs: [] },
    undefined, undefined, { cwd: "." },
  );
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /UX AUDIT ERROR/);
  assert.match(out.content[0].text, /ENOENT/);
}));

test("/ux updates session mode and injects instructions", async () => withTempConfig(async () => {
  const { commands, events, appendedEntries } = createPiHarness();
  const ctx = createCommandContext();

  await events.get("session_start")({ reason: "startup" }, ctx);
  await commands.get("ux").handler("lite", ctx);

  assert.deepEqual(appendedEntries.at(-1), {
    customType: "ux-mode",
    data: { mode: "lite" },
  });

  const result = await events.get("before_agent_start")({ systemPrompt: "BASE" }, ctx);
  assert.ok(result.systemPrompt.includes("UX DISCIPLINE ACTIVE"));
  assert.ok(result.systemPrompt.includes("lite"));
}));

test("before_agent_start guards missing event and missing systemPrompt", async () => withTempConfig(async () => {
  const { events } = createPiHarness();
  const ctx = createCommandContext();

  await events.get("session_start")({ reason: "startup" }, ctx);

  for (const bad of [undefined, null]) {
    const r = await events.get("before_agent_start")(bad, ctx);
    assert.ok(r.systemPrompt.includes("UX DISCIPLINE ACTIVE"));
    assert.ok(!r.systemPrompt.includes("undefined"), "must not contain the literal 'undefined'");
  }

  const empty = await events.get("before_agent_start")({}, ctx);
  assert.ok(empty.systemPrompt.includes("UX DISCIPLINE ACTIVE"));
  assert.ok(!empty.systemPrompt.startsWith("undefined"), "must not start with 'undefined'");

  const withBase = await events.get("before_agent_start")({ systemPrompt: "BASE" }, ctx);
  assert.ok(withBase.systemPrompt.startsWith("BASE\n\n"));
  assert.ok(withBase.systemPrompt.includes("UX DISCIPLINE ACTIVE"));
}));

test("strict banner enforces the audit gate; lite banner recommends it", async () => withTempConfig(async () => {
  const { commands, events } = createPiHarness();
  const ctx = createCommandContext();

  await events.get("session_start")({ reason: "startup" }, ctx);

  await commands.get("ux").handler("strict", ctx);
  const strict = await events.get("before_agent_start")({ systemPrompt: "BASE" }, ctx);
  assert.match(strict.systemPrompt, /level: strict/);
  assert.match(strict.systemPrompt, /block handoff on fail/i);

  await commands.get("ux").handler("lite", ctx);
  const lite = await events.get("before_agent_start")({ systemPrompt: "BASE" }, ctx);
  assert.match(lite.systemPrompt, /level: lite/);
  assert.match(lite.systemPrompt, /recommended but not blocking/i);
}));

test("session_start restores latest persisted mode", async () => withTempConfig(async () => {
  const { events } = createPiHarness();
  const ctx = createCommandContext({
    sessionManager: {
      getEntries: () => [
        { type: "custom", customType: "ux-mode", data: { mode: "lite" } },
      ],
    },
  });

  await events.get("session_start")({ reason: "resume" }, ctx);
  const result = await events.get("before_agent_start")({ systemPrompt: "BASE" }, ctx);
  assert.ok(result.systemPrompt.includes("lite"));
}));

test("off mode injects nothing", async () => withTempConfig(async () => {
  const { commands, events } = createPiHarness();
  const ctx = createCommandContext();

  await events.get("session_start")({ reason: "startup" }, ctx);
  await commands.get("ux").handler("off", ctx);
  const result = await events.get("before_agent_start")({ systemPrompt: "BASE" }, ctx);
  assert.equal(result, undefined);
}));

test("normal mode disables persistent instructions", async () => withTempConfig(async () => {
  const { commands, events } = createPiHarness();
  const ctx = createCommandContext();

  await events.get("session_start")({ reason: "startup" }, ctx);
  await commands.get("ux").handler("strict", ctx);
  await events.get("input")({ text: "normal mode", source: "interactive" }, ctx);

  const disabled = await events.get("before_agent_start")({ systemPrompt: "BASE" }, ctx);
  assert.equal(disabled, undefined);
}));

test("a request mentioning normal mode stays active", async () => withTempConfig(async () => {
  const { commands, events } = createPiHarness();
  const ctx = createCommandContext();

  await events.get("session_start")({ reason: "startup" }, ctx);
  await commands.get("ux").handler("strict", ctx);
  await events.get("input")({ text: "add a normal mode toggle next to dark mode", source: "interactive" }, ctx);

  const result = await events.get("before_agent_start")({ systemPrompt: "BASE" }, ctx);
  assert.match(result.systemPrompt, /UX DISCIPLINE ACTIVE/);
}));

test("resources_discover contributes ONLY the 4 ux skill dirs", () => {
  const { discoverResults } = createPiHarness();
  assert.equal(discoverResults.length, 1);
  const result = discoverResults[0]();
  const names = result.skillPaths.map((p) => p.split("/").filter(Boolean).pop());
  assert.deepEqual(names.sort(), ["ux-capture", "ux-design", "ux-presets", "ux-routing"]);
  for (const p of result.skillPaths) {
    assert.ok(p.includes("/skills/ux-"), "each path is its own skill dir under skills/");
    assert.ok(!p.endsWith("/skills/"), "must not contribute the shared skills/ root");
    assert.ok(existsSync(p), `skill dir exists: ${p}`);
  }
});

// --- /config contribution ---

test("config groups carry the ux.* rows over the Appearance tab", () => {
  const groups = buildUxGroups({ defaultMode: "lite", quietStartup: true });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].tab, "Appearance");
  assert.equal(groups[0].label, "UX discipline");
  const keys = groups[0].rows.map((r) => r.key);
  assert.deepEqual(keys, ["ux.defaultMode", "ux.quietStartup"]);
  const mode = groups[0].rows[0];
  assert.deepEqual(mode.values, ["off", "lite", "strict"]);
  assert.equal(mode.defaultValue, "strict");
  const quiet = groups[0].rows[1];
  assert.equal(quiet.defaultValue, false);
});

test("uxConfig save persists defaultMode + quietStartup to the pi-ux config file", async () => withTempConfig(async () => {
  const { ui } = createCommandContext();
  let notified = "";
  const contrib = uxConfig();
  const groups = contrib.groups();
  // Simulate the panel: mutate via the row setters, then save with owned keys.
  groups[0].rows[0].set("off");
  groups[0].rows[1].set(true);
  await contrib.save(new Set(["ux.defaultMode", "ux.quietStartup"]), { ui: { notify: (m) => (notified = m) } });

  const configPath = join(process.env.XDG_CONFIG_HOME, "pi-ux", "config.json");
  assert.ok(existsSync(configPath));
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), { defaultMode: "off", quietStartup: true });
  assert.match(notified, /UX config saved/);
}));

test("uxConfig save no-ops without an owned key", async () => withTempConfig(async () => {
  const contrib = uxConfig();
  const configPath = join(process.env.XDG_CONFIG_HOME, "pi-ux", "config.json");
  await contrib.save(new Set(["router.baseUrl"]), { ui: { notify() {} } });
  assert.equal(existsSync(configPath), false, "no config file written");
}));

test("uxConfig save reports an env-shadowed default", async () => withTempConfig(async () => {
  process.env.PI_UX_DEFAULT_MODE = "lite";
  let notified = "";
  const contrib = uxConfig();
  contrib.groups()[0].rows[0].set("strict");
  await contrib.save(new Set(["ux.defaultMode"]), { ui: { notify: (m) => (notified = m) } });
  assert.match(notified, /PI_UX_DEFAULT_MODE env keeps the default at lite/);
}));

// --- helpers ---

test("parseUxCommand bare reports status (ponytail #99 precedent, not upstream's reset)", () => {
  assert.deepEqual(parseUxCommand(""), { type: "status" });
  assert.deepEqual(parseUxCommand("   "), { type: "status" });
});

test("parseUxCommand parses modes and status (no default subcommand — /config owns it)", () => {
  assert.deepEqual(parseUxCommand("lite"), { type: "set-mode", mode: "lite" });
  assert.deepEqual(parseUxCommand("STRICT"), { type: "set-mode", mode: "strict" });
  assert.deepEqual(parseUxCommand("status"), { type: "status" });
  assert.deepEqual(parseUxCommand("default lite"), { type: "invalid", reason: "invalid-mode", mode: "default" });
  assert.deepEqual(parseUxCommand("banana"), { type: "invalid", reason: "invalid-mode", mode: "banana" });
});

test("resolveSessionMode prefers latest persisted session mode", () => {
  const entries = [
    { type: "custom", customType: "ux-mode", data: { mode: "lite" } },
    { type: "custom", customType: "ux-mode", data: { mode: "strict" } },
  ];
  assert.equal(resolveSessionMode(entries, "strict"), "strict");
});

test("resolveSessionMode returns fallback when entries is not an array", () => {
  assert.equal(resolveSessionMode(null, "strict"), "strict");
  assert.equal(resolveSessionMode("not an array"), "strict"); // DEFAULT_MODE fallback
});

test("readDefaultMode and writeDefaultMode use XDG config path", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "ux-config-"));
  const previousXdg = process.env.XDG_CONFIG_HOME;
  const previousDefault = process.env.PI_UX_DEFAULT_MODE;
  const configPath = join(tempDir, "pi-ux", "config.json");
  process.env.XDG_CONFIG_HOME = tempDir;
  delete process.env.PI_UX_DEFAULT_MODE;

  try {
    assert.equal(readDefaultMode(), "strict");
    assert.equal(writeDefaultMode("lite"), "lite");
    assert.equal(readDefaultMode(), "lite");
    assert.ok(existsSync(configPath));
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), { defaultMode: "lite" });
  } finally {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    if (previousDefault === undefined) delete process.env.PI_UX_DEFAULT_MODE;
    else process.env.PI_UX_DEFAULT_MODE = previousDefault;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("readQuietStartup resolves env var, config file, and default in that order", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "ux-quiet-"));
  const previousXdg = process.env.XDG_CONFIG_HOME;
  const previousEnv = process.env.PI_UX_QUIET_STARTUP;
  const configDir = join(tempDir, "pi-ux");
  const configPath = join(configDir, "config.json");
  process.env.XDG_CONFIG_HOME = tempDir;
  delete process.env.PI_UX_QUIET_STARTUP;

  try {
    assert.equal(readQuietStartup(), false);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({ quietStartup: true }), "utf8");
    assert.equal(readQuietStartup(), true);
    process.env.PI_UX_QUIET_STARTUP = "0";
    assert.equal(readQuietStartup(), false);
  } finally {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    if (previousEnv === undefined) delete process.env.PI_UX_QUIET_STARTUP;
    else process.env.PI_UX_QUIET_STARTUP = previousEnv;
    rmSync(tempDir, { recursive: true, force: true });
  }
});
