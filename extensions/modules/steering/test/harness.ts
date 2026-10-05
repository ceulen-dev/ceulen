// Fake-pi harness for the steering lifecycle tests (adapted from
// pi-model-tools' ds-anchor-wiring / cache-stats / guidance harnesses): the
// module's handlers are collected off a stub ExtensionAPI and fired directly
// with synthetic events, so the returned results can be asserted on.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import steeringModule from "../index.js";

type Hook = (event: any, ctx: any) => any;

/** Point the `steering` settings reads at a throwaway agent dir, so the tests
 *  never see the developer's real ~/.pi/agent/settings.json. Call from
 *  before()/after() with the returned restore(). */
export function isolateAgentDir(prefix = "ceulen-steering-test-"): { dir: string; restore: () => void } {
  const real = process.env.PI_CODING_AGENT_DIR;
  const dir = mkdtempSync(join(tmpdir(), prefix));
  process.env.PI_CODING_AGENT_DIR = dir;
  return {
    dir,
    restore: () => {
      if (real === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = real;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Write a `steering` settings section into the isolated agent dir — the next
 *  turn (before_agent_start) picks it up. */
export function setSteeringSettings(dir: string, steering: Record<string, unknown>): void {
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ steering }, null, 2));
}

export interface FakePi {
  fire: (name: string, event: any, ctx: any) => any;
  ctx: (id: string, extra?: Record<string, unknown>) => any;
  status: (ctx: any) => string;
  setEntries: (entries: any[]) => void;
  /** Messages the module steered into the session (reminders). */
  messages: Array<{ message: any; options: any }>;
  commands: Record<string, any>;
  notifications: string[];
  /** Tools the module registered at load (think scratchpad when gated on). */
  tools: Array<Record<string, unknown>>;
}

export function createFakePi(activeTools: string[] = ["bash", "read", "edit", "grep", "str_replace_editor"]): FakePi {
  const hooks = new Map<string, Hook[]>();
  const commands: Record<string, any> = {};
  const messages: Array<{ message: any; options: any }> = [];
  const notifications: string[] = [];
  let entries: any[] = [];
  const tools: Array<Record<string, unknown>> = [];

  const pi: any = {
    registerCommand: (name: string, def: any) => { commands[name] = def; },
    registerTool: (def: any) => { tools.push(def); },
    on: (name: string, fn: Hook) => { (hooks.get(name) ?? hooks.set(name, []).get(name)!).push(fn); },
    getActiveTools: () => activeTools,
    getAllTools: () => activeTools.map((name) => ({ name })),
    sendMessage: (message: any, options: any) => { messages.push({ message, options }); },
  };
  steeringModule(pi);

  const fire = (name: string, event: any, ctx: any) => {
    let last: any;
    for (const handler of hooks.get(name) ?? []) last = handler(event, ctx) ?? last;
    return last;
  };

  const ctx = (id: string, extra: Record<string, unknown> = {}): any => ({
    model: { id, provider: "test" },
    cwd: "/tmp",
    isProjectTrusted: () => false,
    sessionManager: { getEntries: () => entries },
    ui: { notify: (message: string) => { notifications.push(message); } },
    ...extra,
  });

  const status = (c: any): string => {
    let text = "";
    commands.steering.handler({}, { model: c.model, cwd: c.cwd, ui: { notify: (t: string) => { text = t; } } });
    return text;
  };

  return {
    fire,
    ctx,
    status,
    setEntries: (e: any[]) => { entries = e; },
    messages,
    commands,
    notifications,
    tools,
  };
}
