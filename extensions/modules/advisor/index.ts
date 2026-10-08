/**
 * advisor — second-model reviewer (ported from `@bacnh85/pi-advisor` 0.3.8).
 *
 * After every settled turn with real work, an isolated reviewer model examines
 * the transcript and may emit ONE severity-routed note (nit / concern /
 * blocker), delivered as a follow-up instruction or — inside the post-steer
 * calm-down window — deferred to the next turn as an LLM-visible aside. The
 * same configured chain backs the on-demand `advisor` tool.
 *
 * Config lives in the `advisor` section of the agent-dir settings.json (trusted
 * project `.pi/settings.json` overrides; the standalone package's `pi-advisor`
 * section is read-compatible and migrated on first save) — `/config` → Model →
 * Advisor is the editor, applied live. See lib/config.ts for the file contract.
 */
import {
  getMarkdownTheme,
  type BeforeAgentStartEventResult,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";

import { DEFAULTS, loadAdvisorSettings, writeAdvisorSettings, type AdvisorConfig } from "./lib/config.js";
import { MAX_NOTE_LENGTH, isSeverity, sanitizeNote, type Severity } from "./lib/emission-guard.js";
import { createGuard } from "./lib/emission-guard.js";
import { REVIEW_ENTRY, createRuntime, latestEntryId, reseedCursor, reviewTurn, type IsolatedCall, type WatcherRuntime } from "./lib/watcher.js";
import { registerAdvisor, type AdvisorHandle } from "./commands/advisor.js";
import { setAdvisorBridge, setAdvisorRegistry } from "./configPanel.js";

// ponytail: test-only injection — real calls use runIsolatedChain (watcher's default); tests swap it.
let testIsolated: IsolatedCall | undefined;
export function __setIsolatedForTest(fn: IsolatedCall | undefined): void {
  testIsolated = fn;
}

// ponytail: test-only read of the newest module instance's runtime (cursor/wiring assertions).
let testRuntime: (() => WatcherRuntime | undefined) | undefined;
export function __getRuntimeForTest(): WatcherRuntime | undefined {
  return testRuntime?.();
}

interface NoteData {
  severity: Severity;
  note: string;
  timestamp: number;
  deferred?: boolean;
}

/** Shared card body for the entry renderer and the message-renderer fallback. */
function renderNoteCard(raw: NoteData | undefined, expanded: boolean, theme: Theme): Box {
  const data = raw && isSeverity(raw.severity) && typeof raw.note === "string"
    ? { ...raw, note: sanitizeNote(raw.note).slice(0, MAX_NOTE_LENGTH) }
    : { severity: "nit" as Severity, note: "(unavailable)", timestamp: 0 };
  const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
  const label = data.deferred ? "Advisor (deferred — next turn)" : "Advisor";
  const sev = data.severity === "blocker"
    ? theme.fg("error", data.severity)
    : data.severity === "concern"
      ? theme.fg("warning", data.severity)
      : theme.fg("dim", data.severity);
  box.addChild(new Text(`${theme.fg("accent", theme.bold(label))} ${sev} ${theme.fg("dim", data.timestamp ? new Date(data.timestamp).toLocaleTimeString() : "")}`, 0, 0));
  box.addChild(new Markdown(data.note, 0, 0, getMarkdownTheme()));
  if (expanded && data.timestamp) box.addChild(new Text(theme.fg("dim", new Date(data.timestamp).toLocaleString()), 0, 0));
  return box;
}

export default function advisorModule(pi: ExtensionAPI): void {
  let runtime: WatcherRuntime | undefined;
  testRuntime = () => runtime;
  let runtimeSessionId: string | undefined;
  /** Effective settings as last loaded/applied — the base for partial writes. */
  let settings: AdvisorConfig = DEFAULTS;
  let cwd = process.cwd();
  let trusted = false;
  /** Session-scoped watch flag: defaults to the persisted master, toggled by
   *  /advisor on|off, never written. */
  let watchEnabled = false;
  let handle: AdvisorHandle | undefined;

  /** Adopt committed settings in the live session (the file write is the caller's). */
  function applySettings(next: AdvisorConfig, ctx: ExtensionContext): void {
    const masterChanged = next.enabled !== settings.enabled;
    settings = next;
    // The session watch state this save TARGETS — computed before the reseed
    // below: an explicit master change re-arms/disarms the session, an unchanged
    // master leaves a /advisor watch-off override in place. Reading watchEnabled
    // directly would miss a save that sets enabled + chain together, because
    // watchEnabled is only updated at the end of this function.
    const willWatch = masterChanged ? next.enabled : watchEnabled;
    const rt = runtime;
    if (rt) {
      rt.config = next;
      rt.models = next.models;
      // Re-enabling clears an accumulated 3-strike pause (same as /advisor on).
      if (next.enabled) {
        rt.stats.paused = false;
        rt.failures = 0;
      }
      // Enabling mid-session must not replay history: reseed on FIRST
      // activation (cursor still undefined), which covers BOTH the 0→N chain
      // transition and the enable-only save on a session that started with
      // enabled:false + a configured chain (a no-chain or disabled session
      // never seeds the cursor, so `undefined` is exactly "not yet active").
      if (willWatch && rt.models.length > 0 && rt.cursor === undefined) reseedCursor(rt, ctx);
    }
    // An explicit master change re-arms/disarms the session; otherwise a
    // /advisor watch-off override stays in place.
    if (masterChanged) watchEnabled = next.enabled;
  }

  pi.registerEntryRenderer<NoteData>(REVIEW_ENTRY, (entry, { expanded }, theme) => {
    return renderNoteCard(entry.data, expanded, theme);
  });

  // Message renderer for next-turn asides (LLM-visible deferred notes). In the
  // TUI the deferred message is display:false (the immediate card is the visible
  // surface), so this is a fallback for non-TUI surfaces that render flushed
  // messages.
  pi.registerMessageRenderer<NoteData>(REVIEW_ENTRY, (message, { expanded }, theme) => {
    const raw = (message as unknown as { details?: unknown }).details as NoteData | undefined;
    return renderNoteCard(raw, expanded, theme);
  });

  pi.on("before_agent_start", (event, ctx): BeforeAgentStartEventResult | undefined => {
    // Headless runs can't receive watch notes — don't make them pay dead
    // prompt text claiming otherwise.
    if (ctx.mode !== "tui" || !watchEnabled || !runtime || runtime.models.length === 0 || runtime.stats.paused) return;
    // ponytail: pi passes a plain string here (omp forks expose string[]).
    const base = typeof event?.systemPrompt === "string" ? event.systemPrompt : "";
    // Every turn the agent sees the authority line (static per session,
    // cache-safe): messages starting 'Advisor review' are reviewer findings.
    const line = "Advisor notes: messages starting 'Advisor review' are authoritative reviewer findings. Fix or explicitly justify ignoring each finding.";
    if (base.includes(line)) return;
    return { systemPrompt: `${base}${base ? "\n\n" : ""}${line}` };
  });

  pi.on("session_start", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId?.();
    const fresh = runtimeSessionId !== sessionId;
    runtimeSessionId = sessionId;
    cwd = ctx.cwd ?? process.cwd();
    trusted = ctx.isProjectTrusted?.() === true;
    if (runtime && !fresh) return; // same session — already initialized
    settings = loadAdvisorSettings(cwd, trusted);
    runtime = createRuntime(settings, settings.models);
    watchEnabled = settings.enabled;
    setAdvisorRegistry(ctx.modelRegistry);
    // Watch is gated on both the master switch and a configured chain — no self-review.
    if (!watchEnabled || settings.models.length === 0) return;
    // Seed the cursor to the current transcript tail so the first review
    // covers only work that happens after the advisor was loaded.
    runtime.cursor = latestEntryId(ctx.sessionManager.getEntries() as any[]);
  });

  // Self-disarm on session teardown: session_shutdown is emitted and awaited
  // BEFORE the runner invalidates (agent-session-runtime teardownCurrent), so
  // flipping the flag here makes live() false in this (about-to-be-orphaned)
  // closure — an in-flight fire-and-forget review is discarded silently
  // instead of throwing the stale-ctx error into the .catch and toasting the
  // NEW session. The factory re-runs per session, so this never touches a
  // live session's flag.
  pi.on("session_shutdown", () => { watchEnabled = false; });

  // Transcript rewritten (compaction) or a different conversation becoming
  // active (switch/resume): the cursor points at pre-rewrite entry ids and
  // the guard's dedupe history covers notes against the OLD transcript —
  // reseed both (omp parity: reviewer state resets across history rewrites).
  // Skipped when the runtime belongs to a replaced session — that runtime's
  // factory self-disarmed via session_shutdown.
  function resetForRewrite(ctx: ExtensionContext): void {
    if (!runtime || (runtimeSessionId !== undefined && runtimeSessionId !== ctx.sessionManager.getSessionId?.())) return;
    reseedCursor(runtime, ctx);
    runtime.guard = createGuard();
  }
  pi.on("session_compact", (_event, ctx) => resetForRewrite(ctx));
  pi.on("session_before_switch", (_event, ctx) => resetForRewrite(ctx));

  pi.on("agent_settled", async (event, ctx) => {
    if (!runtime || !watchEnabled || runtime.stats.paused) return;
    // pi 1.1.0 flags runs the user cancelled (Escape). A half-finished
    // transcript is not worth an isolated review — and reviewing it would
    // steer on work the user deliberately stopped. Absent on older pi →
    // undefined → falsy → today's behavior.
    if ((event as { aborted?: boolean }).aborted) return;
    // Only TUI: a floating review would die at process exit in headless
    // modes, and a note there fired an unrequested follow-up run. Fail-safe:
    // unknown/mode-less contexts skip too (missed review < surprise run).
    if (ctx.mode !== "tui") return;
    // ponytail: fire-and-forget — pi core awaits agent_settled handlers before
    // the TUI regains input, so awaiting the 10-90s+ review here froze the UI
    // after every turn. Notes deliver via sendUserMessage, which the SDK
    // queues as a steer when a run is active or fires as a follow-up turn
    // when idle. A still-running review makes the next settle skip (rt
    // reviewing flag) — bounded loss, not queued.
    const rt = runtime;
    // Liveness guard evaluated at delivery time (not just settle time): a
    // fresh session (/new) replaces runtime, /advisor off clears the chain,
    // watch-off flips the flag, repeated failures pause — a review in flight
    // across any of these must deliver nothing.
    const live = () => runtime === rt && watchEnabled && rt.models.length > 0 && !rt.stats.paused;
    // Reviews/notes additionally require "not paused": the 3-strike pause exists
    // precisely because the review just failed, so a notify behind live() could
    // never tell the user the watch stopped. Passed as a separate predicate — the
    // pause flag still suppresses outbound notes and further reviews.
    const alive = () => runtime === rt && watchEnabled && rt.models.length > 0;
    void reviewTurn(rt, ctx, {
      sendMessage: (message, options) => { if (live()) pi.sendMessage(message, options as never); },
      sendUserMessage: (content, options) => { if (live()) pi.sendUserMessage(content, options); },
      appendEntry: (customType, data) => { if (live()) pi.appendEntry(customType, data); },
      notify: (message) => { if (alive()) ctx.ui.notify(message, "error"); },
    }, testIsolated).catch((err) => { if (live()) ctx.ui.notify(`Advisor review failed: ${String(err)}`, "error"); });
  });

  handle = registerAdvisor(pi, {
    getSettings: () => settings,
    isEnabled: () => settings.enabled,
    isWatchEnabled: () => watchEnabled,
    setWatchEnabled: (value) => { watchEnabled = value; },
    getRuntime: () => runtime,
    onEnableWatch: (ctx) => { if (runtime) reseedCursor(runtime, ctx); },
    setModels: (models, ctx) => {
      const previous = settings.models;
      settings = { ...settings, models };
      writeAdvisorSettings(settings);
      if (!runtime) return;
      runtime.config = settings;
      runtime.models = models;
      // Chain enabled mid-session: review only future work.
      if (previous.length === 0 && models.length > 0 && watchEnabled) reseedCursor(runtime, ctx);
    },
  });

  // /config bridge: the panel reads effective settings and, on save, applies
  // them here — the section edits need no /reload (munin/classifier precedent).
  setAdvisorBridge({
    read: () => loadAdvisorSettings(cwd, trusted),
    apply: (next, ctx) => {
      applySettings(next, ctx);
      handle?.sync(ctx);
    },
  });
}
