// Live probe for the child-session contamination fix (run with tsx).
// Reproduces the incident's exact mechanism in-process:
//  1. Fire ceulen composer's host session_start (module-scope liveCtx installed).
//  2. Create a child pi session through the SAME SDK path the a2a runner uses
//     (DefaultResourceLoader.reload → createAgentSession → bindExtensions print),
//     marking it like makeSessionRunner does.
//  3. Emit the child's session_shutdown + dispose.
//  4. Assert the host liveCtx survived (pre-fix it was undefined → blank band).
import composerModule, { __liveCtxForTests } from "../extensions/modules/composer/index.ts";
import { markChildSession } from "../extensions/lib/child-session.ts";

const handlers = new Map();
composerModule({
  on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
  getSettings: () => ({ compaction: { enabled: true } }),
});
const hostCtx = {
  mode: "tui",
  hasUI: true,
  cwd: process.cwd(),
  sessionManager: { id: "host" },
  thinkingLevel: "medium",
  ui: { theme: { fg: (_c, s) => s, bold: (s) => s }, notify() {}, setStatus() {}, setWidget() {}, setEditorComponent() {}, setFooter() {} },
};
for (const h of handlers.get("session_start")) await h({}, hostCtx);
if (__liveCtxForTests() !== hostCtx) throw new Error("probe setup failed: liveCtx not installed");
console.log("host liveCtx installed ✓");

// Child session — the a2a makeSessionRunner path (ceulen is the installed
// package in this agent dir, so the child loads the same bundle).
const sdk = await import("@earendil-works/pi-coding-agent");
const { createAgentSession, SessionManager, SettingsManager, DefaultResourceLoader } = sdk;
const loader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir: sdk.getAgentDir() });
await loader.reload({ resolveProjectTrust: async () => true });
const sm = SessionManager.inMemory(process.cwd(), { id: "task-probe" });
markChildSession(sm);
const created = await createAgentSession({
  cwd: process.cwd(),
  model: undefined,
  resourceLoader: loader,
  sessionManager: sm,
  settingsManager: SettingsManager.inMemory({}),
});
const session = created.session;
await session.bindExtensions({ mode: "print" });
console.log("child bound ✓");
await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
await session.dispose();

if (__liveCtxForTests() !== hostCtx) {
  console.error("FAIL: host liveCtx was clobbered by the child lifecycle (the incident)");
  process.exit(1);
}
console.log("host liveCtx survived the child session ✓ — fix verified");
process.exit(0);
