import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createLocalBashOperations, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { hasUnsupportedRtkFind } from "./findFallback.js";
import { parseSemver, supportsFindPassthrough } from "./version-gate.js";
import { isSafeRewrite } from "./safe-rewrite.js";
import { readRtkSettings } from "./lib/settings.js";

const REWRITE_TIMEOUT_MS = 2_000;
const RTK_UNAVAILABLE_RETRY_MS = 30_000;
const MIN_SUPPORTED_RTK: [number, number, number] = [0, 23, 0];

// ponytail: deliberate duplicate of version-gate.js's private isAtLeastVersion —
// pi's jiti loader pairs a reloaded index.ts with stale cached siblings, so
// importing NEW exports from existing files crashes /reload (0.2.1 regression).
function isAtLeastVersion(current: [number, number, number], minimum: [number, number, number]): boolean {
  for (let i = 0; i < minimum.length; i += 1) {
    if (current[i] > minimum[i]) return true;
    if (current[i] < minimum[i]) return false;
  }
  return true;
}
const RTK_SUBCOMMANDS = ["enable", "disable", "status"] as const;

// The honest prompt note: states the POLICY (what RTK can rewrite), not the
// outcome of any given command. Kept as one constant so every turn injects
// byte-identical text (prefix-cache head).
const RTK_NOTE =
  "Your bash commands are rewritten through RTK where RTK supports them " +
  "(git, ls, rg, read, test runners as single commands); chains, redirects, " +
  "inline scripts, and unsupported commands pass through unchanged.";

let sessionEnabled = true;
let rtkUnavailableNotified = false;
let rtkAvailable: boolean | undefined;
let rtkLastCheckedAt = 0;
let rtkSupportsFindPassthrough = false;
let rtkVersion: string | null = null;
// Dedupes the pass-through notify: two identical chains back to back notify
// once. Reset on session_start.
let lastPassthroughCommand = "";

function rewritingEnabled(): boolean {
  return sessionEnabled && !isRtkDisabled();
}

function isRtkDisabled(): boolean {
  const val = process.env.RTK_DISABLED;
  if (!val) return false;
  const lower = val.trim().toLowerCase();
  return lower === "1" || lower === "true" || lower === "yes" || lower === "y";
}

function notifyRtkUnavailable(ctx: ExtensionContext, message: string): void {
  if (rtkUnavailableNotified) return;
  rtkUnavailableNotified = true;
  if (ctx.hasUI) ctx.ui.notify(message, "warning");
  else console.warn(message);
}

async function getRtkVersion(pi: ExtensionAPI): Promise<string | null> {
  const result = await pi.exec("rtk", ["--version"], { timeout: REWRITE_TIMEOUT_MS }).catch(() => undefined);
  if (!result || result.code !== 0) return null;
  return result.stdout.trim() || null;
}

async function checkRtkAvailable(pi: ExtensionAPI, ctx: ExtensionContext): Promise<boolean> {
  // Availability gate: rtk >= 0.23.0 for `rtk rewrite`. A >= 0.46 binary does
  // NOT affect availability — it only re-enables find passthrough below.
  // Conservatively reset passthrough on every check; only a verified >=0.46
  // binary re-enables it.
  rtkSupportsFindPassthrough = false;
  const version = await getRtkVersion(pi);
  rtkVersion = version;
  if (!version) {
    rtkAvailable = false;
    rtkLastCheckedAt = Date.now();
    notifyRtkUnavailable(ctx, "[pi-rtk] rtk binary not found in PATH; shell command rewrites will pass through unchanged");
    return false;
  }

  const parsedVersion = parseSemver(version.replace(/^rtk\s+/, ""));
  if (parsedVersion && !isAtLeastVersion(parsedVersion, MIN_SUPPORTED_RTK)) {
    rtkAvailable = false;
    rtkLastCheckedAt = Date.now();
    notifyRtkUnavailable(ctx, `[pi-rtk] ${version} is too old; need rtk >= 0.23.0 for \`rtk rewrite\`; shell command rewrites will pass through unchanged`);
    return false;
  }

  // rtk 0.46 dispatches on find's grammar and passes unmodeled predicates
  // through to real find (never-worse guard) — safe subset of find predicates
  // no longer needs blocking there.
  rtkSupportsFindPassthrough = !!parsedVersion && supportsFindPassthrough(version);
  rtkAvailable = true;
  rtkLastCheckedAt = Date.now();
  rtkUnavailableNotified = false;
  return true;
}

async function ensureRtkAvailableForRewrite(pi: ExtensionAPI, ctx: ExtensionContext): Promise<boolean> {
  if (rtkAvailable !== false) return true;
  if (Date.now() - rtkLastCheckedAt < RTK_UNAVAILABLE_RETRY_MS) return false;
  return checkRtkAvailable(pi, ctx);
}

async function rewriteCommand(pi: ExtensionAPI, command: string, ctx: ExtensionContext, signal?: AbortSignal): Promise<string | null> {
  if (!(await ensureRtkAvailableForRewrite(pi, ctx))) return null;

  const result = await pi.exec("rtk", ["rewrite", command], {
    timeout: REWRITE_TIMEOUT_MS,
    signal,
  }).catch(() => undefined);

  if (!result) {
    if (signal?.aborted) return null;
    rtkAvailable = false;
    rtkLastCheckedAt = Date.now();
    notifyRtkUnavailable(ctx, "[pi-rtk] rtk rewrite failed to start; shell command rewrites will pass through unchanged");
    return null;
  }

  rtkAvailable = true;
  rtkLastCheckedAt = Date.now();
  rtkUnavailableNotified = false;
  if (result.killed) return null;
  // rtk rewrite exit codes: 0 = no rewrite (empty stdout), 1 = error,
  // 3 = successful rewrite (rewritten command in stdout).
  // Accept both 0 and 3 as success; we read stdout regardless of exit code.
  if (result.code !== 0 && result.code !== 3) return null;

  const rewritten = result.stdout.trim();
  if (hasUnsupportedRtkFind(rewritten, rtkSupportsFindPassthrough)) return null;
  return rewritten.length > 0 ? rewritten : null;
}


/** Rewrite decision for one command: the command to execute (null = the
 *  original passes through) plus whether RTK was CONSULTED — true when the
 *  gate allowed reaching the binary (enabled, mode on, chain rules passed)
 *  regardless of the outcome. The tool_call path uses it to surface honest
 *  pass-through notifies; the user_bash path ignores it. */
async function maybeRewriteCommand(pi: ExtensionAPI, command: string, ctx: ExtensionContext, signal?: AbortSignal): Promise<string | null> {
  const outcome = await decideRewrite(pi, command, ctx, signal);
  return outcome.rewritten;
}

async function decideRewrite(pi: ExtensionAPI, command: string, ctx: ExtensionContext, signal?: AbortSignal): Promise<{ rewritten: string | null; consulted: boolean }> {
  if (!rewritingEnabled()) return { rewritten: null, consulted: false };
  if (typeof command !== "string" || command.trim() === "") return { rewritten: null, consulted: false };
  if (command.trimStart().startsWith("rtk ")) return { rewritten: null, consulted: false };
  const settings = readRtkSettings();
  if (settings.mode === "off") return { rewritten: null, consulted: false };
  // `chained: "never"`: chains (| ; & && ||, unquoted) never rewrite — skip
  // the spawn entirely; the command executes byte-identical. rtk models few
  // chains (90% of this repo's measured traffic failed open anyway), so this
  // saves a wasted process per call.
  if (settings.chained === "never" && hasUnquotedChainOperator(command)) return { rewritten: null, consulted: false };
  let rewritten = await rewriteCommand(pi, command, ctx, signal);
  let consulted = true;
  if (rewritten && rewritten !== command && !isSafeRewrite(command, rewritten)) {
    rewritten = null;
    consulted = false; // unsafe rewrite rejected — the model must not read this as rtk passing judgment
  }
  return { rewritten, consulted };
}

/** True when the command carries a chain/separator operator outside quotes.
 *  ponytail: quote-scanning split (no full shell grammar) — a false positive
 *  can only SKIP a rewrite, never rewrite something unsafe. */
function hasUnquotedChainOperator(command: string): boolean {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (quote) {
      if (ch === "\\" && quote === '"') i += 1; // escaped char inside double quotes
      else if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === "|" || ch === ";" || ch === "&") {
      return true;
    }
  }
  return false;
}

async function showRtkStatus(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const available = await checkRtkAvailable(pi, ctx);
  // Reuse the version checkRtkAvailable just fetched — no second spawn.
  const version = available ? rtkVersion : null;
  const envDisabled = isRtkDisabled();
  const cacheState = rtkAvailable === false ? `unavailable (retry in ${Math.max(0, Math.ceil((RTK_UNAVAILABLE_RETRY_MS - (Date.now() - rtkLastCheckedAt)) / 1000))}s)` : "available";
  const lines = [
    `Session toggle: ${sessionEnabled ? "enabled" : "disabled"}`,
    `RTK_DISABLED: ${envDisabled ? "1 (rewrites bypassed)" : "not set"}`,
    `Runtime cache: ${cacheState}`,
    `Binary: ${version ?? "rtk not detected on PATH"}`,
    "Tip: use /rtk enable, /rtk disable, /rtk status; use RTK_DISABLED=1 for an environment-level bypass.",
  ];
  ctx.ui.notify(lines.join("\n"), "info");
}

async function handleRtkCommand(pi: ExtensionAPI, args: string, ctx: ExtensionContext): Promise<void> {
  const subcommand = args.trim();
  if (subcommand.length === 0) {
    await showRtkStatus(pi, ctx);
    return;
  }

  if (!(RTK_SUBCOMMANDS as readonly string[]).includes(subcommand)) {
    ctx.ui.notify("Unknown /rtk subcommand. Valid forms: /rtk enable, /rtk disable, /rtk status.", "error");
    return;
  }

  if (subcommand === "status") {
    await showRtkStatus(pi, ctx);
    return;
  }

  sessionEnabled = subcommand === "enable";
  ctx.ui.notify(`pi-rtk ${sessionEnabled ? "enabled" : "disabled"} for this session`, "info");
}

export default function piRtkExtension(pi: ExtensionAPI) {
  const localBashOperations = createLocalBashOperations();

  pi.registerCommand("rtk", {
    description: "Control pi-rtk shell command rewriting",
    getArgumentCompletions: (prefix) => {
      const items = RTK_SUBCOMMANDS
        .filter((k) => k.startsWith(prefix.trim().toLowerCase()))
        .map((k) => ({ value: k, label: k }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      await handleRtkCommand(pi, args, ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    // Reset per-session toggle
    sessionEnabled = true;
    rtkUnavailableNotified = false;
    lastPassthroughCommand = "";
    await checkRtkAvailable(pi, ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
  });

  pi.on("before_agent_start", async (event) => {
    if (!rewritingEnabled()) return;
    // Truth gate: when the binary is known-missing, rewrites pass through —
    // don't tell the model its commands are rewritten. Re-checked every turn,
    // so once the 30s re-probe flips rtkAvailable back to true, the note
    // is injected again on subsequent turns.
    if (rtkAvailable === false) return;
    // ONE STATIC sentence stating the policy, not the outcome — byte-identical
    // every turn (the system prompt is the prefix-cache head; per-turn state
    // here would bust it). Per-command truth rides the [pi-rtk] notifies on
    // the tool_call path instead.
    return {
      systemPrompt: event.systemPrompt +
        "\n\n" + RTK_NOTE,
    };
  });

  pi.on("tool_call", async (event, ctx) => {
    try {
      if (!isToolCallEventType("bash", event)) return;

      const originalCommand = event.input.command;
      const outcome = await decideRewrite(pi, originalCommand, ctx, ctx.signal);
      const rewritten = outcome.rewritten;
      if (rewritten && rewritten !== originalCommand) {
        // Notify when a command is rewritten so the model sees the discrepancy
        if (ctx.hasUI) {
          ctx.ui.notify(`[pi-rtk] rewrote: ${originalCommand.slice(0, 80)} → ${rewritten.slice(0, 80)}`, "info");
        }
        event.input.command = rewritten;
      } else if (ctx.hasUI && outcome.consulted) {
        // Close the phantom-rewrite loop: rtk was consulted (available, not
        // disabled, command shape allowed the spawn) but returned nothing —
        // the shell runs the ORIGINAL bytes. Surface it so the model doesn't
        // argue with its own tool-call echo. Consecutive identical
        // pass-throughs notify once (repeated test-runner chains).
        if (originalCommand !== lastPassthroughCommand) {
          lastPassthroughCommand = originalCommand;
          ctx.ui.notify(`[pi-rtk] passed through unchanged: ${originalCommand.slice(0, 80)}`, "info");
        }
      }
    } catch (error) {
      const msg = "[pi-rtk] unexpected rewrite error; passing bash command through unchanged";
      if (ctx.hasUI) ctx.ui.notify(msg, "warning");
      else console.warn(msg, error);
    }
  });

  pi.on("user_bash", async (event, ctx) => {
    try {
      if (event.excludeFromContext) return;

      const rewritten = await maybeRewriteCommand(pi, event.command, ctx, ctx.signal);
      if (!rewritten || rewritten === event.command) return;
      return {
        operations: {
          exec: (_command, cwd, options) => localBashOperations.exec(rewritten, cwd, options),
        },
      };
    } catch (error) {
      const msg = "[pi-rtk] unexpected user_bash rewrite error; passing command through unchanged";
      if (ctx.hasUI) ctx.ui.notify(msg, "warning");
      else console.warn(msg, error);
      return;
    }
  });
}
