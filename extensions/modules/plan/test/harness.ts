// Fake-pi harness for the plan module lifecycle tests: module handlers are
// collected off a stub ExtensionAPI and fired directly with synthetic events,
// so returned results can be asserted on (steering-harness pattern).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import planModule from "../index.js";

type Hook = (event: any, ctx: any) => any;

/** Point the `plan` settings reads at a throwaway agent dir. */
export function isolateAgentDir(prefix = "ceulen-plan-test-"): { dir: string; restore: () => void } {
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

export function setPlanSettings(dir: string, plan: Record<string, unknown>): void {
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ plan }, null, 2));
}

export interface FakePi {
  fire: (name: string, event: any, ctx: any) => Promise<any>;
  ctx: (extra?: Record<string, unknown>) => any;
  commands: Record<string, any>;
  tools: Record<string, any>;
  shortcuts: Record<string, any>;
  notifications: string[];
  userMessages: Array<{ content: any; options: any }>;
  entryTypes: string[];
  /** Every pi.appendEntry call with its data. */
  entries: Array<{ customType: string; data: any }>;
  /** State appended to a fresh session by /plan-approve new (setup hook). */
  newSessionStates: Array<{ customType: string; data: any }>;
  /** Messages the replacement session received (withSession hook). */
  newSessionMessages: Array<{ content: any; options: any }>;
  activeTools: () => string[];
}

export function createFakePi(initialTools: string[] = ["bash", "read", "edit", "write", "grep"]): FakePi {
  const hooks = new Map<string, Hook[]>();
  const commands: Record<string, any> = {};
  const tools: Record<string, any> = {};
  const shortcuts: Record<string, any> = {};
  const notifications: string[] = [];
  const userMessages: Array<{ content: any; options: any }> = [];
  const entryTypes: string[] = [];
  const entries: Array<{ customType: string; data: any }> = [];
  const newSessionStates: Array<{ customType: string; data: any }> = [];
  const newSessionMessages: Array<{ content: any; options: any }> = [];
  let activeTools = [...initialTools];
  let branchEntries: any[] = [];

  const pi: any = {
    registerCommand: (name: string, def: any) => { commands[name] = def; },
    registerTool: (tool: any) => { tools[tool.name] = tool; },
    registerShortcut: (key: string, def: any) => { shortcuts[key] = def; },
    registerFlag: () => {},
    getFlag: () => undefined,
    on: (name: string, fn: Hook) => { (hooks.get(name) ?? hooks.set(name, []).get(name)!).push(fn); },
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => { activeTools = [...names]; },
    appendEntry: (customType: string, data: unknown) => { entryTypes.push(customType); entries.push({ customType, data }); },
    sendUserMessage: (content: any, options: any) => { userMessages.push({ content, options }); },
    sendMessage: () => {},
    getThinkingLevel: () => "medium",
    setThinkingLevel: () => {},
    setModel: async () => true,
    getSettings: () => ({}),
    events: { emit: () => {}, on: () => () => {} },
  };
  planModule(pi);

  const fire = async (name: string, event: any, ctx: any) => {
    let last: any;
    for (const handler of hooks.get(name) ?? []) {
      const out = await handler(event, ctx);
      if (out !== undefined) last = out;
    }
    return last;
  };

  const ctx = (extra: Record<string, unknown> = {}): any => ({
    cwd: "/tmp",
    mode: "tui",
    hasUI: true,
    isProjectTrusted: () => false,
    model: { id: "m1", provider: "test" },
    modelRegistry: { getAvailable: () => [], find: () => undefined, refresh: async () => {} },
    sessionManager: { getBranch: () => branchEntries, getSessionFile: () => undefined, appendCustomEntry: () => {} },
    waitForIdle: async () => {},
    newSession: async (options?: { setup?: (sm: any) => Promise<void>; withSession?: (ctx: any) => Promise<void> }) => {
      await options?.setup?.({ appendCustomEntry: (customType: string, data: unknown) => { newSessionStates.push({ customType, data }); } });
      await options?.withSession?.({ sendUserMessage: (content: any, opts: any) => { newSessionMessages.push({ content, options: opts }); } });
      return { cancelled: false };
    },
    getContextUsage: () => ({ percent: 10 }),
    ui: {
      notify: (message: string) => { notifications.push(message); },
      select: async () => undefined,
      editor: async () => undefined,
      setStatus: () => {},
      setEditorText: () => {},
      theme: { fg: (_c: string, t: string) => t },
    },
    ...extra,
  });

  return {
    fire,
    ctx,
    commands,
    tools,
    shortcuts,
    notifications,
    userMessages,
    entryTypes,
    entries,
    newSessionStates,
    newSessionMessages,
    activeTools: () => [...activeTools],
    setEntries: (e: any[]) => { branchEntries = e; },
  } as FakePi & { setEntries: (e: any[]) => void };
}
