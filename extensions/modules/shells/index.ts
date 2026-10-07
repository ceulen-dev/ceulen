// shells — background shell sessions (Claude Code BashOutput/KillShell +
// Codex unified_exec parity). ONE `shell` tool over actions:
// start/list/output/stdin/kill. Sessions live for THIS pi session only —
// killed on session_shutdown, cleared on session_start. Plan mode blocks the
// tool (plan/lib/plan-tools.ts BLOCKED_TOOLS).

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import path from "node:path";
import { Type } from "typebox";
import { readDisabledTools } from "../../lib/tools.js";
import {
  createSession,
  killSession,
  resolveSession,
  SessionStore,
  type ShellSession,
} from "./lib/sessions.js";

const ACTION_ENUM = ["start", "list", "output", "stdin", "kill"] as const;
type Action = (typeof ACTION_ENUM)[number];

/** Default lines shown per output call. */
const OUTPUT_LINES_DEFAULT = 100;
/** Hard cap on lines per output call (the ring itself is the real bound). */
const OUTPUT_LINES_MAX = 1000;

function requireString(params: Record<string, unknown>, key: string, action: Action): string {
  const v = params[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`action:"${action}" requires a string "${key}" param`);
  }
  return v;
}

function requireSession(params: Record<string, unknown>, store: SessionStore, action: Action): ShellSession {
  const idOrName = params.id ?? params.name;
  if (typeof idOrName !== "string" || idOrName.length === 0) {
    throw new Error(`action:"${action}" requires a session "id" (or "name") — use action:"list" to see sessions`);
  }
  return resolveSession(store, idOrName);
}

/** Trim one line for list output. */
function lastLine(buf: { lines(): string[] }): string {
  const lines = buf.lines();
  const last = lines.at(-1) ?? "";
  return last.length > 80 ? `${last.slice(0, 77)}…` : last;
}

function renderList(store: SessionStore): string {
  const sessions = store.list();
  if (sessions.length === 0) return "(no sessions)";
  const lines = sessions.map((s) => {
    const name = s.name ? `  ${s.name}` : "";
    const status = s.exitedAt === undefined ? "running" : `exited code ${s.exitCode ?? "signal"}`;
    const uptime = `${Math.max(0, Math.round(((s.exitedAt ?? Date.now()) - s.startedAt) / 1000))}s`;
    const kb = Math.round((s.stdout.totalWritten() + s.stderr.totalWritten()) / 1024);
    return `${s.id}${name}  ${status}  ${uptime}  ${kb}KB  ${lastLine(s.stdout)}`;
  });
  return lines.join("\n");
}

function renderOutput(session: ShellSession, params: Record<string, unknown>): string {
  const max = Math.min(Math.max(1, Number(params.lines ?? OUTPUT_LINES_DEFAULT) || OUTPUT_LINES_DEFAULT), OUTPUT_LINES_MAX);
  const since = params.since === "last" ? "last" : "start";
  const out: string[] = [];
  let truncated = false;
  // Each stream slices by ITS OWN cursor — one shared offset went stale on
  // the shorter stream (stderr duplicated when stdout was longer, invisible
  // when shorter). Cursors are lifetime line counts, not array indices:
  // a ring-cap trip SHRINKS the visible array, which strands an index
  // cursor above it forever (permanent "no new output yet" blackout).
  const cursorOf = { stdout: "lastStdoutOffset", stderr: "lastStderrOffset" } as const;
  for (const stream of ["stdout", "stderr"] as const) {
    const buf = session[stream];
    if (since === "last") {
      const fresh = buf.linesSince(session[cursorOf[stream]]);
      if (fresh.length === 0) continue;
      const shown = fresh.slice(-max);
      if (fresh.length > shown.length) truncated = true;
      out.push(`── ${stream} (new) ──`, ...shown);
      // Advance ONLY on since:"last" reads, and only forward.
      session[cursorOf[stream]] = Math.max(session[cursorOf[stream]], buf.lifetimeLines());
    } else {
      const all = buf.lines();
      if (all.length === 0) continue;
      const shown = all.slice(-max);
      if (all.length > shown.length) truncated = true;
      out.push(`── ${stream} ──`, ...shown);
    }
  }
  if (out.length === 0) return `${session.id}: no ${since === "last" ? "new " : ""}output yet`;
  const totalLines = session.stdout.lines().length + session.stderr.lines().length;
  out.push(`── total ${totalLines} line(s)${truncated || session.stdout.isTruncated() || session.stderr.isTruncated() ? ", buffer truncated" : ""} ──`);
  return out.join("\n");
}

export default function shellsModule(pi: ExtensionAPI): void {
  const store = new SessionStore();
  (shellsModule as unknown as { __storeForTests?: SessionStore }).__storeForTests = store;

  pi.on("session_start", () => {
    // A fresh session can't reach children from a replaced one.
    store.clear(); // killAll already ran on shutdown; plain clear
  });

  pi.on("session_shutdown", () => {
    // Fire-and-forget: the session is going away regardless (advisor
    // self-disarm precedent). Never blocks the shutdown path.
    void store.killAll("SIGTERM").catch(() => {});
  });

  pi.registerTool({
    name: "shell",
    label: "Shell",
    defaultActive: !readDisabledTools().has("shell"),
    description: [
      "Run a shell command as a PERSISTENT background session and interact with it across tool calls (dev servers, watchers, long builds). Actions:",
      '- start: {command, name?, cwd?} — spawn in its own process group; returns an id ("s1"…).',
      '- list: every session with id/name, status (running | exited code N), uptime, buffered KB, last line.',
      '- output: {id, lines? (default 100), since?: "start"|"last"} — buffered stdout/stderr (separate sections); since:"last" returns only lines after the previous output call.',
      '- stdin: {id, data, newline? (default true)} — write to the process\'s stdin.',
      '- kill: {id, signal? ("SIGTERM"|"SIGKILL", default TERM)} — kill the process GROUP (children die too).',
      "",
      "Sessions live only for this pi session: killed on shutdown, not persisted. Output is ring-buffered (256 KB/stream, head+tail kept). Blocked in plan mode.",
    ].join("\n"),
    promptSnippet: "Persistent background shell sessions: start/list/output/stdin/kill",
    promptGuidelines: [
      'Poll with action:"output" after starting a long process; use since:"last" to fetch only new lines.',
      "Prefer the regular bash tool for one-shot commands — sessions are for processes that keep running.",
      "A dev server started here stays up across tool calls; kill it when done.",
    ],
    parameters: Type.Object({
      action: Type.Union(
        ACTION_ENUM.map((a) => Type.Literal(a)),
        { description: "Operation to perform." },
      ),
      command: Type.Optional(Type.String({ description: 'Shell command (start), e.g. "npm run dev".' })),
      name: Type.Optional(Type.String({ description: "Your own alias for the session (start); usable instead of id later. Must be unique among live sessions." })),
      cwd: Type.Optional(Type.String({ description: "Working directory (start; default the session cwd)." })),
      id: Type.Optional(Type.String({ description: "Session id (output/stdin/kill) or name — from action:\"list\"." })),
      lines: Type.Optional(Type.Number({ description: "output: max lines per stream (default 100, cap 1000)." })),
      since: Type.Optional(
        Type.Union([Type.Literal("start"), Type.Literal("last")], { description: 'output: "last" returns only lines since the previous output call.' }),
      ),
      data: Type.Optional(Type.String({ description: "stdin: bytes to write." })),
      newline: Type.Optional(Type.Boolean({ description: "stdin: append \\n (default true)." })),
      signal: Type.Optional(
        Type.Union([Type.Literal("SIGTERM"), Type.Literal("SIGKILL")], { description: "kill: signal (default SIGTERM)." }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
      const action = params.action as Action;
      const cwd = ctx?.cwd || process.cwd();
      try {
        switch (action) {
          case "start": {
            const command = requireString(params, "command", "start");
            const session = createSession(store, spawn, {
              command,
              cwd: path.resolve(cwd, (params.cwd as string | undefined) ?? "."),
              name: typeof params.name === "string" && params.name.length > 0 ? params.name : undefined,
            });
            const label = session.name ? ` "${session.name}"` : "";
            return {
              content: [
                {
                  type: "text",
                  text: `started ${session.id}${label} pid ${session.pid} — ${command}\npoll with shell action:"output" id:"${session.id}"; stop with action:"kill".`,
                },
              ],
              details: { action, id: session.id, pid: session.pid },
            };
          }
          case "list": {
            return { content: [{ type: "text", text: renderList(store) }], details: { action, count: store.list().length } };
          }
          case "output": {
            const session = requireSession(params, store, "output");
            return {
              content: [{ type: "text", text: renderOutput(session, params) }],
              details: { action, id: session.id },
            };
          }
          case "stdin": {
            const session = requireSession(params, store, "stdin");
            const data = requireString(params, "data", "stdin");
            const stdin = session.child.stdin;
            if (!stdin || session.exitedAt !== undefined) {
              throw new Error(`process not reading stdin (exited or stdin closed): ${session.id}`);
            }
            stdin.write(data + (params.newline === false ? "" : "\n"));
            return {
              content: [{ type: "text", text: `wrote ${data.length + (params.newline === false ? 0 : 1)} byte(s) to ${session.id}` }],
              details: { action, id: session.id },
            };
          }
          case "kill": {
            const session = requireSession(params, store, "kill");
            const sig = (params.signal as "SIGTERM" | "SIGKILL" | undefined) ?? "SIGTERM";
            const result = await killSession(session, sig);
            // Free the slot: evict exited sessions beyond the keep count.
            store.evictOldestExited();
            const how = result.signal ? `signal ${result.signal}` : `exit code ${result.code ?? "?"}`;
            return {
              content: [{ type: "text", text: `killed ${session.id} (${how})` }],
              details: { action, id: session.id },
            };
          }
        }
      } catch (err) {
        return {
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          isError: true as const,
          details: { action },
        };
      }
    },
  });
}

// ponytail: test seam — a constructor-injected store would be the upgrade
// path if non-test code ever needs it; one module-scope slot, last load wins.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const shellsModuleAny = shellsModule as unknown as { __storeForTests?: SessionStore };
export const getStoreForTests = (): SessionStore | undefined => shellsModuleAny.__storeForTests;
