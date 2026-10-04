/// Regression test (round-2 review): `a2a-send` getArgumentCompletions must
/// return null — not throw — before the first session_start has captured a
/// context (hot-reload / fresh registration), and produce peer entries after
/// one has fired. Guards the `if (!lastA2aCtx) return null;` line in index.ts.
import { describe, it, afterEach } from "node:test";
import { assert as chai } from "./chai.js";
// expect-style chains below are mechanical chai→assert conversions
import a2aExtension from "../index.js";
import { makeTempDir } from "./tmp.js";

interface CommandDef {
  getArgumentCompletions?: (prefix: string) => unknown;
  handler: (args: string, ctx: unknown) => Promise<void>;
}

/** Minimal stub of the pi ExtensionAPI surface used at registration time. */
function stubPi() {
  const commands = new Map<string, CommandDef>();
  const handlers = new Map<string, ((...a: unknown[]) => unknown)[]>();
  const pi = {
    registerMessageRenderer: () => {},
    registerTool: () => {},
    registerCommand: (name: string, def: CommandDef) => {
      commands.set(name, def);
    },
    on: (event: string, fn: (...a: unknown[]) => unknown) => {
      const list = handlers.get(event) ?? [];
      list.push(fn);
      handlers.set(event, list);
    },
  };
  return { pi, commands, handlers };
}

describe("a2a-send completion guard (lastA2aCtx)", () => {
  const dirs: string[] = [];
  const savedPiDir = process.env.PI_CODING_AGENT_DIR;

  afterEach(() => {
    if (savedPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedPiDir;
  });

  it("returns null before any session_start (no throw), peer entries after", async () => {
    const dir = makeTempDir("pi-a2a-guard-");
    dirs.push(dir);
    process.env.PI_CODING_AGENT_DIR = dir; // isolate from the operator's ~/.pi

    const { pi, commands, handlers } = stubPi();
    a2aExtension(pi as never);

    const cmd = commands.get("a2a-send");
    chai.exists(cmd, "a2a-send command registered");
    chai.equal(typeof cmd!.getArgumentCompletions, "function", "command exposes completions");

    // BEFORE any session_start: guard must return null, not throw
    // (cfgFor(undefined) would throw without the guard).
    chai.equal(cmd!.getArgumentCompletions!(""), null);

    // Fire session_start with a ctx that carries a configured peer.
    const ctx = {
      cwd: dir,
      hasUI: true,
      mode: "host",
      settings: { a2a: { peers: { alpha: { url: "http://127.0.0.1:9901" } } } },
    };
    for (const fn of handlers.get("session_start") ?? []) await fn({}, ctx);

    const items = cmd!.getArgumentCompletions!("") as { value: string }[];
    chai.lengthOf(items as unknown as unknown[], 1, "completions produce entries after session_start");
    chai.equal((items[0] as { value: string }).value, "alpha");
  });
});
