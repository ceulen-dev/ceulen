/** ceulen extension-surface tests — kill-switch wiring, skill discovery,
 *  customType rename. (Upstream extension surface had no ceulen deltas to
 *  test; everything here guards the port's integration points.) */
import { describe, it, beforeEach, afterEach } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { assert } from "./chai.js";

const tmpDirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return fs.realpathSync(dir);
}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import a2aExtension, { a2aServerRunning, restartA2AServer } from "../index.ts";

/** Minimal ExtensionAPI stub capturing registrations (completion-guard pattern). */
function stubPi() {
  const tools: Array<{ name: string; defaultActive?: boolean }> = [];
  const commands = new Map<string, { description: string }>();
  const renderers = new Map<string, unknown>();
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  const resources: Array<() => unknown> = [];
  const pi = {
    registerTool: (tool: { name: string; defaultActive?: boolean }) => {
      tools.push(tool);
    },
    registerCommand: (name: string, cmd: { description: string }) => {
      commands.set(name, cmd);
    },
    registerMessageRenderer: (type: string, renderer: unknown) => {
      renderers.set(type, renderer);
    },
    on: (event: string, handler: (...args: any[]) => any) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    sendMessage: () => {},
    registerFlag: () => {},
    registerShortcut: () => {},
    registerEntryRenderer: () => {},
    registerProvider: () => {},
  };
  return { pi: pi as unknown as ExtensionAPI, tools, commands, renderers, handlers, resources };
}

describe("a2a extension surface (ceulen port)", () => {
  beforeEach(() => {
    savedEnv.PI_CODING_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
    savedEnv.CEULEN_SETTINGS = process.env.CEULEN_SETTINGS_TEST;
  });
  afterEach(() => {
    process.env.PI_CODING_AGENT_DIR = savedEnv.PI_CODING_AGENT_DIR;
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("registers the 7 outbound tools", () => {
    const dir = makeTempDir("pi-a2a-ext-");
    process.env.PI_CODING_AGENT_DIR = dir;
    const { pi, tools } = stubPi();
    a2aExtension(pi);
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ["a2a_call", "a2a_discover", "a2a_history", "a2a_list", "a2a_orchestrate", "a2a_peers", "a2a_status"],
    );
  });

  it("contributes the a2a skill via resources_discover (kill-switch gated by module load)", () => {
    const dir = makeTempDir("pi-a2a-ext-");
    process.env.PI_CODING_AGENT_DIR = dir;
    const { pi, handlers } = stubPi();
    a2aExtension(pi);
    const discover = handlers.get("resources_discover")?.[0];
    assert.exists(discover, "resources_discover handler registered");
    const out = discover!() as { skillPaths: string[] };
    assert.lengthOf(out.skillPaths, 1);
    assert.equal(path.basename(out.skillPaths[0]!), "a2a");
    assert.isTrue(fs.existsSync(path.join(out.skillPaths[0]!, "SKILL.md")), "skill dir ships SKILL.md");
  });

  it("uses the ceulen-a2a-inbound customType for the message renderer", () => {
    const dir = makeTempDir("pi-a2a-ext-");
    process.env.PI_CODING_AGENT_DIR = dir;
    const { pi, renderers } = stubPi();
    a2aExtension(pi);
    assert.isTrue(renderers.has("ceulen-a2a-inbound"), "renderer registered under ceulen-a2a-inbound");
    assert.isFalse(renderers.has("a2a-inbound"), "upstream customType renamed");
  });

  it("registers the 8 ceulen commands (NO /a2a-config — /config owns it)", () => {
    const dir = makeTempDir("pi-a2a-ext-");
    process.env.PI_CODING_AGENT_DIR = dir;
    const { pi, commands } = stubPi();
    a2aExtension(pi);
    const names = [...commands.keys()].sort();
    assert.deepEqual(names, [
      "a2a-agents",
      "a2a-broadcast",
      "a2a-discover",
      "a2a-help",
      "a2a-peers",
      "a2a-send",
      "a2a-server",
      "a2a-status",
    ]);
    assert.isFalse(commands.has("a2a-config"), "/a2a-config dropped — central /config owns settings");
  });

  it("exposes the restart bridge exports", () => {
    assert.equal(typeof a2aServerRunning, "function");
    assert.equal(typeof restartA2AServer, "function");
  });
});
