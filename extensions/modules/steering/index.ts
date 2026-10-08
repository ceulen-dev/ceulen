/**
 * steering — per-model-family steering for ceulen.
 *
 * Ported from @bacnh85/pi-model-tools 0.9.5 (extensions/index.ts): the
 * model-FAMILY half of that extension, with two things deliberately left to
 * their own ceulen modules —
 *   • the tool-input repair / edit-repair / apply_patch / str_replace_editor
 *     TOOLS (the "repair" module),
 *   • the zai-provider hooks (before_provider_headers, after_provider_response,
 *     fast-mode body) — the "zai" module.
 *
 * What stays here is everything that depends on knowing WHICH model family is
 * serving the request, plus the DeepSeek v4 Pro minimal-mode anchor:
 *
 *   1. family detection (deepseek-v4 | glm), latched from the requested model
 *      and the session-captured one (proxies rewrite ctx.model between hooks).
 *   2. cache-safe prompt composition — static blocks (Super Power, selection
 *      guidance, apply_patch preference) prepend/append to the system prompt,
 *      while per-turn blocks (error hints, first-tool hints) ride the CURRENT
 *      user message tail via before_provider_request, so the cache head stays
 *      byte-identical.
 *   3. reasoning_content strip + leaked-content cleaning of the request history.
 *   4. tool-error categorization → the next turn's recovery hint, plus the
 *      reasoning-accumulation 400 detector.
 *   5. DeepSeek-only semantic-miss / dedicated-tool steering on tool_call.
 *   6. the ds-anchor two-phase bootstrap for deepseek-v4-pro.
 *
 * ORDERING CONTRACT (why this module is its own unit): in ceulen's registry
 * `steering` loads AFTER ponytail and subagent, so this `before_agent_start`
 * handler runs LAST in the chain (each handler's returned systemPrompt becomes
 * the next handler's event.systemPrompt). Therefore:
 *   • the bootstrap branch deliberately REPLACES the whole prompt — everything
 *     earlier handlers composed is sacrificed for request #1, which is the
 *     entire point of the anchor;
 *   • every other branch COMPOSES: the incoming systemPrompt is preserved
 *     verbatim and only prepended/appended to. Never clobber outside bootstrap.
 *
 * Config: the `steering` section of the agent-dir settings.json, overlaid by a
 * trusted project `.pi/settings.json` (lib/settings.ts), read per turn — so
 * /config → Model → Steering applies without /reload.
 */
// ponytail: ported from @bacnh85/pi-model-tools 0.9.5 extensions/index.ts (the
// hooks + state machine); the repair tools/hooks and the zai provider hooks are
// excluded — they are their own ceulen modules. The PI_MODEL_TOOLS_* env knobs
// became `steering` settings rows, with two dropped: the auto-block-after-
// reminders threshold is now a fixed policy inside strictSerena, and the
// reasoning-truncation budget is a function argument.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isPlanActive } from "../../lib/plan-bridge.ts";
import { detectFamily, type ModelFamily } from "./lib/family.js";
import {
  applyPatchPreferenceGuidance,
  clearGuidanceCache,
  deepSeekSelectionGuidance,
  githubCloneFirstToolHint,
  readUncertainPathHint,
  runTaskFirstToolHint,
  superPowerPrompt,
} from "./lib/guidance.js";
import {
  appendGuidanceToLastUserMessage,
  cleanLeakedContentFromMessages,
  stripReasoningContent,
  tailIsPlainUserPrompt,
} from "./lib/history.js";
import {
  BOOTSTRAP_TOOLS,
  MINIMAL_SYSTEM_PROMPT,
  WE_NEED_DIRECTIVE,
  dshBootstrapTools,
  hasPromotionSignal,
  isAnchorTarget,
} from "./lib/anchor.js";
import {
  categorizeToolError,
  detectReasoningRejection,
  isSemanticMissToolCall,
  missedDedicatedTool,
  suggestBestSerenaCommand,
  type ErrorCategory,
  type ErrorInfo,
} from "./lib/errors.js";
import { readSteeringSettings, type SteeringSettings } from "./lib/settings.js";
import { thinkTool } from "./lib/think.js";

// The integrator may import the /config contribution from either file
// (classifier imports configPanel, composer re-exports from index).
export { steeringConfig } from "./configPanel.js";

/** Reminder count at which STRICT Serena mode escalates a repeated
 *  bash-instead-of-dedicated-tool miss to a block. Upstream's
 *  PI_MODEL_TOOLS_AUTO_BLOCK_AFTER_REMINDERS knob is dropped: the policy is
 *  fixed and only engaged under `steering.strictSerena`. ponytail: if a
 *  different number is ever needed it becomes a settings row next to the
 *  toggle. */
const BLOCK_AFTER_REMINDERS = 3;
/** Cap on the per-tool error-history map (upstream's default). */
const MAX_ERROR_HISTORY = 100;
/** DSH's captured minimal-mode output budget — pinned on the bootstrap request. */
const BOOTSTRAP_MAX_TOKENS = 256000;
/** customType for steering notes. LLM-visible (unlike …status output). */
const STEERING_MESSAGE_TYPE = "ceulen-steering";

/** Defensive view of the assistant message fields index.ts reads (usage and
 *  stopReason are typed non-optional, but OpenAI-compatible providers emit
 *  partial/NaN records and tests inject them). */
interface AssistantLike {
  role?: string;
  stopReason?: string;
  errorMessage?: string;
  content?: unknown[];
  usage?: { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown };
}

export default function steeringModule(pi: ExtensionAPI): void {
  // OMP-parity scratchpad: registers only when `steering.thinkTool` is on.
  // Presence binds at LOAD (the /config row carries the reload warning —
  // repair autoBg precedent); the per-tool kill-switch stays live via
  // `ceulen.disabledTools` + /config tool rows.
  if (readSteeringSettings().thinkTool) pi.registerTool(thinkTool() as never);
  let sessionModel: { provider?: string; id?: string } | undefined;
  let activeFamily: ModelFamily | null = null;
  let hasErrorThisTurn = false;
  let lastErrorInfo: ErrorInfo | null = null;
  let remindedThisTurn = false;
  let turnCounter = 0;
  const cacheStats = { input: 0, cacheRead: 0, cacheWrite: 0, hitTurns: 0, missTurns: 0 };
  // Per-turn dynamic guidance (error notes, first-tool hints, periodic
  // reinforcement) stashed here and appended to the CURRENT user message by
  // before_provider_request — never the system prompt (the cache head).
  let pendingGuidance: string | undefined;
  // Effective settings — refreshed per turn (before_agent_start) and at
  // session_start (the anchor bootstrap keys off dsAnchor/weNeed).
  let settings: SteeringSettings = readSteeringSettings();

  // DeepSeek v4 Pro minimal-mode anchor (two-phase bootstrap) state.
  // Invariant: anchorBootstrapping = dsAnchor && target && !anchorPromoted.
  let anchorReady = false;
  let anchorPromoted = false;
  let anchorRunActive = false;
  let anchorInspectedCount = 0;
  let anchorWarned = false;
  // Last-known thinking level (thinking_level_select) — surfaced in status
  // because the DSH minimal-mode recipe requires max thinking.
  let currentThinking: string | undefined;
  // Ring buffer of anchor decisions — surfaced by /steering so the bootstrap can
  // be verified without any debug env.
  const anchorTrace: string[] = [];
  function anchorTracePush(line: string) {
    anchorTrace.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
    if (anchorTrace.length > 8) anchorTrace.shift();
  }

  const reminderCounts = new Map<string, number>();
  const errorHistory = new Map<string, { count: number; lastCategory: ErrorCategory }>();

  function recordError(toolName: string, category: ErrorCategory) {
    errorHistory.set(toolName, { count: (errorHistory.get(toolName)?.count ?? 0) + 1, lastCategory: category });
    while (errorHistory.size > MAX_ERROR_HISTORY) errorHistory.delete(errorHistory.keys().next().value!);
  }

  // Detection: check both ctx.model and session-captured model
  function family(model?: { provider?: string; id?: string }): ModelFamily | null {
    return detectFamily(model) ?? detectFamily(sessionModel);
  }

  // Anchor target: check BOTH ctx.model and session-captured model — proxies
  // rewrite ctx.model between hooks (see family() above for the same defense).
  function anchorTarget(model?: { id?: string }): boolean {
    return settings.dsAnchor && (isAnchorTarget(model?.id) || isAnchorTarget(sessionModel?.id));
  }

  function warnAnchorOnce(ctx: ExtensionContext, message: string) {
    if (anchorWarned) return;
    anchorWarned = true;
    try { ctx.ui?.notify?.(message, "warning"); } catch { /* no UI */ }
  }

  // Scan durable entries for a promotion signal; fail-open on error.
  function scanAnchorEntries(ctx: ExtensionContext) {
    if (anchorPromoted) return;
    try {
      const entries = ctx.sessionManager.getEntries() as unknown[];
      const from = entries.length >= anchorInspectedCount ? anchorInspectedCount : 0;
      if (hasPromotionSignal(entries.slice(from) as never)) anchorPromoted = true;
      anchorInspectedCount = entries.length;
      if (!anchorReady) anchorReady = true;
    } catch {
      anchorPromoted = true;
      warnAnchorOnce(ctx, "steering: ds-anchor session inspection failed; full catalog exposed");
    }
  }

  function anchorBootstrapping(model?: { id?: string }): boolean {
    // Target check per hook — proxies rewrite ctx.model between hooks WITHOUT
    // firing model_select (e.g. a session requested as flash that is served
    // deepseek-v4-pro). Requiring a session_start-latched ready flag silently
    // skipped the bootstrap for such sessions — the exact failure observed in
    // a live a2a gateway session. anchorReady is display-only here.
    const target = anchorTarget(model);
    if (target && !anchorReady) anchorReady = true;
    // Plan mode hard-blocks the mutator tools (str_replace_editor is in
    // plan's BLOCKED_TOOLS), so the DSH pair can never reach the payload.
    // Defer — not fail-open — so the session stays anchorable and the
    // fail-open warning never fires: plan-mode replies promote naturally via
    // the entries scan, and with no replies the bootstrap engages on the
    // first post-exit turn (permission-module precedent: plan-bridge).
    if (isPlanActive()) return false;
    return target && !anchorPromoted;
  }

  // ── /steering ──
  pi.registerCommand("steering", {
    description: "Show per-model-family steering state: active family, flags, ds-anchor, prompt-cache stats.",
    handler: async (_args, cmdCtx) => {
      const anchorActive = anchorTarget(cmdCtx.model); // includes sessionModel fallback
      const anchorState = !anchorActive || !anchorReady
        ? "off"
        : isPlanActive() && !anchorPromoted ? "deferred (plan mode)"
        : anchorPromoted ? "promoted" : "bootstrapping";
      const totalErrors = [...errorHistory.values()].reduce((sum, e) => sum + e.count, 0);
      const status = [
        "## steering status",
        "",
        `**Active family:** ${activeFamily ?? family(cmdCtx.model) ?? "none"}`,
        `  Requested: ${sessionModel?.provider ?? "none"}/${sessionModel?.id ?? "none"}`,
        `  Served: ${cmdCtx.model?.provider ?? "none"}/${cmdCtx.model?.id ?? "none"}`,
        "",
        "**Steering (settings section `steering`):**",
        `  First-tool hints (all families): ${settings.firstToolHints ? "on" : "off"}`,
        `  Selection guidance (DeepSeek V4): ${settings.selectionGuidance ? "on" : "off"}`,
        `  Super Power Mode (DeepSeek V4): ${settings.superpower ? "on" : "off"}${settings.superpowerPrompt ? " (custom prompt)" : ""}`,
        `  Strict Serena (DeepSeek V4): ${settings.strictSerena ? `on (block after ${BLOCK_AFTER_REMINDERS} reminders)` : "off"}`,
        `  Reasoning strip: ${settings.stripReasoning ? "on" : "off"}`,
        `  Leaked content cleaning: always on for detected families`,
        `  ds-anchor (deepseek-v4-pro): ${anchorState}`,
        `  We-need directive (bootstrap): ${settings.weNeed ? "on" : "off"}`,
        `  Thinking level: ${currentThinking ?? "unknown"}${currentThinking !== "max" && anchorActive ? " (recipe wants max)" : ""}`,
        `  Super Power turns: ${turnCounter}`,
        "",
        ...(cacheStats.input > 0
          ? (() => {
              // hitPct = cacheRead / (input + cacheRead + cacheWrite). On
              // DeepSeek, cacheWrite is always 0 (the OpenAI-compatible API does
              // not emit cache_write_tokens), so this is cacheRead / (input +
              // cacheRead). The `input` portion is the inherently uncached
              // growing tail (new user messages + tool results); hitPct reaches
              // ~98-99% on a warm, stable session whose byte-stable prefix is
              // fully cached.
              const total = cacheStats.input + cacheStats.cacheRead + cacheStats.cacheWrite;
              const hitPct = total > 0 ? Math.round((cacheStats.cacheRead / total) * 100) : 0;
              return [
                "**Prompt cache (this session):**",
                `  Input: ${cacheStats.input.toLocaleString()} · cached: ${cacheStats.cacheRead.toLocaleString()} · written: ${cacheStats.cacheWrite.toLocaleString()}`,
                `  Hit rate: ${hitPct}%  (${cacheStats.hitTurns} hit turns · ${cacheStats.missTurns} miss turns)`,
                "",
              ];
            })()
          : []),
        `**Errors:** ${totalErrors} total${lastErrorInfo ? `, last: ${lastErrorInfo.category} on ${lastErrorInfo.toolName}` : ""}`,
        ...(anchorTrace.length > 0 ? ["", "**ds-anchor trace:**", ...anchorTrace.map((l) => `  ${l}`)] : []),
      ];
      cmdCtx.ui.notify(status.join("\n"), "info");
    },
  });

  // ── session_start ──
  pi.on("session_start", (_event, ctx) => {
    sessionModel = ctx.model ? { id: ctx.model.id, provider: ctx.model.provider } : undefined;
    settings = readSteeringSettings(ctx);
    // Capture the session's initial thinking level: thinking_level_select only
    // fires on CHANGES, so a session born at max would otherwise show "unknown"
    // — exactly the case the DSH recipe cares about.
    currentThinking = ctx.thinkingLevel;
    // ds-anchor: reset and init from durable state (resume of a session that
    // already has an assistant reply = instantly promoted, no bootstrap).
    anchorReady = anchorTarget(ctx.model);
    anchorPromoted = false;
    anchorRunActive = false;
    anchorInspectedCount = 0;
    anchorWarned = false;
    anchorTrace.length = 0; // per-session trace — never leak prior-session lines
    anchorTracePush(`session_start: requested=${ctx.model?.id ?? "?"}${anchorTarget(ctx.model) ? " → target" : " → not target"}`);
    scanAnchorEntries(ctx);
    activeFamily = null;
    hasErrorThisTurn = false;
    lastErrorInfo = null;
    remindedThisTurn = false;
    turnCounter = 0;
    clearGuidanceCache();
    reminderCounts.clear();
    errorHistory.clear();
    cacheStats.input = 0;
    cacheStats.cacheRead = 0;
    cacheStats.cacheWrite = 0;
    cacheStats.hitTurns = 0;
    cacheStats.missTurns = 0;
    pendingGuidance = undefined;
  });

  // ── thinking_level_select: track the level (max is required by the DSH recipe) ──
  pi.on("thinking_level_select", (event) => { currentThinking = event.level; });

  // ── model_select: keep the latched model in sync + re-init the anchor when
  //    switching to/from a target ──
  pi.on("model_select", (event, ctx) => {
    // The stale-sessionModel fallback would otherwise keep matching the OLD
    // target after a /model switch away (bootstrap firing on e.g. flash,
    // pinning max_tokens and hiding tools for a non-target model).
    sessionModel = event.model ? { id: event.model.id, provider: event.model.provider } : undefined;
    if (isAnchorTarget(event.model?.id)) {
      if (!anchorReady) {
        anchorReady = true;
        anchorPromoted = false;
        anchorInspectedCount = 0;
        scanAnchorEntries(ctx);
      }
      return;
    }
    // Switched away (or to a non-target): anchor goes inert.
    anchorReady = false;
    anchorPromoted = false;
    anchorRunActive = false;
  });

  // ── before_agent_start: anchor bootstrap, static prompt blocks, dynamic guidance ──
  //
  // Cache-stability split: the system prompt is the byte-stable HEAD of the
  // prefix cache — DeepSeek (exact prefix) and GLM (Z.ai automatic
  // content-similarity cache, https://docs.z.ai/guides/capabilities/cache)
  // both key on it. Anything that varies per turn must NOT go there — a
  // changed head invalidates the cache for the whole request (measured:
  // 99% → 16% hit when a prompt-aware hint fired). Per-turn guidance (error
  // notes, first-tool hints, periodic reinforcement) is stashed in
  // `pendingGuidance` and appended to the current user message (the request
  // tail) by before_provider_request. Static content (Super Power base,
  // selection guidance, apply_patch preference) stays in the system prompt —
  // byte-identical per session, therefore cache-safe.
  pi.on("before_agent_start", (event, ctx) => {
    settings = readSteeringSettings(ctx); // read per turn — /config saves apply live
    activeFamily = family(ctx.model);

    // ds-anchor bootstrap: request #1 gets the byte-identical Minimal prompt
    // and NO guidance (Super Power, selection guidance, hints all suppressed).
    // This handler is LAST in ceulen's chain, so the returned systemPrompt
    // REPLACES everything ponytail/subagent/advisor composed — deliberate, and
    // the only place this module clobbers rather than composes.
    if (anchorBootstrapping(ctx.model)) {
      scanAnchorEntries(ctx);
      if (!anchorPromoted) {
        anchorRunActive = true;
        pendingGuidance = undefined;
        anchorTracePush(`bootstrap: minimal prompt engaged (model=${ctx.model?.id ?? "?"}${settings.weNeed ? ", +we-need directive" : ""})`);
        return { systemPrompt: settings.weNeed ? WE_NEED_DIRECTIVE + MINIMAL_SYSTEM_PROMPT : MINIMAL_SYSTEM_PROMPT };
      }
      // Scan found a durable signal (resume edge) — fall through to the
      // normal path: full prompt + full catalog.
      anchorTracePush("bootstrap skipped: durable signal found (resume)");
    } else if (anchorTarget(ctx.model)) {
      anchorTracePush(isPlanActive() && !anchorPromoted
        ? "bootstrap deferred: plan mode active (mutator tools blocked)"
        : `bootstrap skipped: already promoted=${anchorPromoted}`);
    }

    remindedThisTurn = false;
    if (!activeFamily) return;

    const dynamicParts: string[] = [];

    // Shared error hint from previous turn (all families) — per-turn dynamic.
    if (hasErrorThisTurn && lastErrorInfo) {
      const repeatCount = errorHistory.get(lastErrorInfo.toolName)?.count ?? 0;
      let hint = lastErrorInfo.hint;
      // Provider-level rejections (e.g. reasoning-accumulation 400s) are not
      // fixed by "simpler inputs" — the escalation advice only applies to
      // tool-level errors.
      if (repeatCount >= 2 && lastErrorInfo.toolName !== "provider") hint += ` You have had ${repeatCount} failures on ${lastErrorInfo.toolName}. Try simpler inputs.`;
      dynamicParts.push(`Note: ${hint}`);
    }
    hasErrorThisTurn = false;
    lastErrorInfo = null;

    // Prompt-aware first-tool hints — ALL families (correctness, not steering).
    // Per-turn dynamic (they depend on the current prompt) → user-message tail.
    //
    // activeForHint is the SAME source on every turn (host selectedTools when
    // populated, pi.getActiveTools() otherwise) so the system prompt stays
    // byte-identical — a per-turn source switch would invalidate the cache head.
    const selected = event.systemPromptOptions?.selectedTools;
    const activeForHint: readonly string[] = Array.isArray(selected) && selected.length > 0 ? selected : pi.getActiveTools();
    if (settings.firstToolHints && activeForHint.includes("bash")) {
      const runHint = runTaskFirstToolHint(event.prompt || "");
      if (runHint) dynamicParts.push(runHint);
      const ghHint = githubCloneFirstToolHint(event.prompt || "");
      if (ghHint) dynamicParts.push(ghHint);
    }
    if (settings.firstToolHints && activeForHint.includes("find")) {
      const readHint = readUncertainPathHint(event.prompt || "");
      if (readHint) dynamicParts.push(readHint);
    }

    // Compose, never clobber: keep whatever earlier handlers put in the prompt.
    let systemPrompt = event.systemPrompt;

    // apply_patch preference — DeepSeek V4 (flash+pro) + GLM. DeepSeek keeps
    // it as a safety net for real-world multi-file/frontmatter edits; GLM was
    // excluded per the 2026-07-29 eval (edit-only usage), but 2026-09 session
    // evidence showed GLM flash models falling back to bash heredocs
    // (cat/python) for file creation without any steering — the hint (now with
    // a create→write line) covers both families. Static per session (depends
    // only on the active-tool set), so the prefix cache is unaffected.
    if (activeFamily === "deepseek-v4" || activeFamily === "glm") {
      const patchHint = applyPatchPreferenceGuidance(activeForHint);
      if (patchHint) systemPrompt = `${systemPrompt}\n\n${patchHint}`;
    }

    // DeepSeek-only: Super Power Mode + verbose selection guidance (DeepSeek V4
    // needs the full steering block; GLM reaches 100% with prompt-aware hints alone).
    if (activeFamily === "deepseek-v4") {
      const prefixParts: string[] = [];

      if (settings.superpower) {
        turnCounter++;
        prefixParts.push(superPowerPrompt(settings.superpowerPrompt));
        // Periodic reinforcement is per-turn dynamic → user-message tail, not
        // the cache head (a head change every 10 turns forces a full miss).
        if (turnCounter % 10 === 0) dynamicParts.push("Super Power Mode active — maximum capability, no limits.");
      }

      if (settings.selectionGuidance) {
        if (["serena_get_symbols_overview", "serena_find_symbol", "serena_find_referencing_symbols", "serena_find_declaration", "serena_find_implementations", "obsidian", "ls", "grep", "find", "read", "edit", "bash"].some((n) => activeForHint.includes(n))) {
          prefixParts.push(deepSeekSelectionGuidance(activeForHint));
        }
      }

      if (prefixParts.length > 0) {
        systemPrompt = `${prefixParts.join("\n\n---\n\n")}\n\n---\n\n${systemPrompt}`;
      }
    }

    pendingGuidance = dynamicParts.length > 0 ? dynamicParts.join("\n\n---\n\n") : undefined;
    return systemPrompt === event.systemPrompt ? undefined : { systemPrompt };
  });

  // ── before_provider_request: anchor payload + dynamic guidance + history cleaning ──
  //
  // before_provider_headers / after_provider_response are NOT registered here —
  // the zai module owns those (fast-mode + client signing).
  pi.on("before_provider_request", (event, ctx) => {
    if (!family(ctx.model)) return;
    let payload: unknown = event.payload;
    // ds-anchor bootstrap: replace the provider payload's tools with the
    // byte-exact DSH Minimal pair. Request-level only — Pi's global active-tool
    // state is untouched; execution routes to the registered tools by name.
    if (anchorBootstrapping(ctx.model) && anchorRunActive) {
      const p = payload as Record<string, unknown> | undefined;
      const filtered = dshBootstrapTools(p?.tools);
      if (!filtered.ok) {
        anchorPromoted = true; // fail-open
        anchorTracePush(`FAIL-OPEN: ${filtered.reason}`);
        warnAnchorOnce(ctx, `steering: ds-anchor ${filtered.reason}; bootstrap disabled, full catalog exposed`);
      } else {
        // max_tokens: the DSH captured minimal-mode payload sent 256000, and
        // dsh-anchored-standard issue #11 isolated the output budget as a
        // trajectory lever. Match it on the bootstrap request only. Exactly one
        // budget field is emitted — the other is dropped from the spread so a
        // payload carrying both can't send conflicting fields.
        const other = p?.max_completion_tokens !== undefined ? "max_completion_tokens" : "max_tokens";
        const dropped = other === "max_tokens" ? "max_completion_tokens" : "max_tokens";
        const { [dropped]: _omit, ...rest } = p ?? {};
        payload = { ...rest, tools: filtered.tools, [other]: BOOTSTRAP_MAX_TOKENS };
        anchorTracePush(`payload: tools=[bash,str_replace_editor] + ${other}=${BOOTSTRAP_MAX_TOKENS} sent to ${ctx.model?.id ?? "?"}`);
      }
    }
    // Append per-turn dynamic guidance to the current user message (request
    // tail) so the system-prompt cache head stays byte-identical across turns
    // (both DeepSeek exact-prefix and GLM Z.ai content-similarity caches).
    // FIRST ROUND OF THE TURN ONLY (payload tail is still the plain user
    // prompt): mid-turn rounds end with tool results, where re-appending the
    // hint reads as a fresh repeated demand and loops strict models into
    // re-running bash ("I've been complying") instead of settling.
    if (pendingGuidance && tailIsPlainUserPrompt(payload)) {
      const withGuidance = appendGuidanceToLastUserMessage(payload, pendingGuidance);
      if (withGuidance !== payload) payload = withGuidance;
    }
    payload = cleanLeakedContentFromMessages(payload, pi.getAllTools().map((t) => t.name));
    if (settings.stripReasoning) payload = stripReasoningContent(payload);
    if (payload !== event.payload) return payload;
  });

  // ── tool_execution_end: categorize errors for the next turn's hint ──
  pi.on("tool_execution_end", (event, ctx) => {
    if (!event.isError || !family(ctx.model)) return;
    hasErrorThisTurn = true;
    const info = categorizeToolError(event.toolName, event.result, pi.getActiveTools());
    lastErrorInfo = info;
    recordError(event.toolName, info.category);
  });

  // ── message_end: detect reasoning-accumulation 400s (provider rejects the
  //    request once prior reasoning_content grows too large). Feeds the shared
  //    error-hint path so the NEXT turn's user message carries the actionable
  //    fix. Only fires on the stopReason === "error" assistant message, so it
  //    never double-counts normal tool errors (those arrive via
  //    tool_execution_end). ──
  pi.on("message_end", (event, ctx) => {
    if (!family(ctx.model)) return;
    const msg = event.message as unknown as AssistantLike;
    if (msg.role !== "assistant" || msg.stopReason !== "error") return;
    const errorText = String(msg.errorMessage ?? "");
    if (!detectReasoningRejection(errorText)) return;
    hasErrorThisTurn = true;
    lastErrorInfo = {
      category: "reasoning_rejected",
      toolName: "provider",
      hint: settings.stripReasoning
        ? "The provider rejected this request (accumulated reasoning_content or a content-length overflow). Reasoning strip is already on — the session context is probably genuinely too long; compact or shorten it."
        : 'The provider rejected this request, likely due to accumulated reasoning_content in prior turns (or a content-length overflow). Turn on /config → Model → Steering → "Strip reasoning" and retry.',
    };
    recordError("provider", "reasoning_rejected");
  });

  // ── agent_end: the per-turn steering latch closes with the run ──
  pi.on("agent_end", () => { remindedThisTurn = false; });

  // ── agent_settled: end of the anchor run window ──
  pi.on("agent_settled", () => { anchorRunActive = false; });

  // ── turn_end: anchor promotion + prompt-cache usage bookkeeping ──
  pi.on("turn_end", (event) => {
    // ds-anchor: promote only on a DURABLE assistant reply — an error/aborted
    // bootstrap request (429, network blip, 400 from the injected payload) must
    // NOT silently promote the session (matches hasPromotionSignal's
    // non-empty-content semantics; keeps the retry anchored).
    const msg = event.message as unknown as AssistantLike;
    if (anchorRunActive && msg.role === "assistant") {
      const durable =
        msg.stopReason !== "error" &&
        msg.stopReason !== "aborted" &&
        Array.isArray(msg.content) &&
        msg.content.length > 0;
      if (durable) {
        anchorPromoted = true;
        anchorRunActive = false;
        anchorTracePush("promoted: first durable assistant reply received");
      } else {
        anchorTracePush(`bootstrap: reply not durable (stopReason=${msg.stopReason ?? "?"}) — retry stays anchored`);
      }
    }
    // turn_end fires once per assistant LLM call (agent-loop emits per round),
    // so each message.usage is a single API call — no double-counting.
    if (msg.role !== "assistant") return;
    const usage = msg.usage;
    if (!usage) return;
    // `?? 0` covers missing fields; the finite check also rejects NaN (some
    // OpenAI-compatible providers emit NaN usage) — NaN would poison the sums
    // and surface as "Hit rate: NaN%" or hide the cache block entirely.
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    const input = num(usage.input);
    const cacheRead = num(usage.cacheRead);
    const cacheWrite = num(usage.cacheWrite);
    if (input === 0 && cacheRead === 0 && cacheWrite === 0) return;
    cacheStats.input += input;
    cacheStats.cacheRead += cacheRead;
    cacheStats.cacheWrite += cacheWrite;
    // A turn with only cacheWrite (first turn of a session) is a miss: the
    // prefix was computed and written, not read back from cache.
    if (cacheRead > 0) cacheStats.hitTurns++;
    else cacheStats.missTurns++;
  });

  // ── tool_call: DeepSeek-only steering (the dangerous-command guard and the
  //    read-on-guessed-path guard live in their own modules) ──
  pi.on("tool_call", (event, ctx) => {
    const f = family(ctx.model);
    if (!f) return;

    // ds-anchor bootstrap: the payload declared only bash + str_replace_editor
    // (before_provider_request), so block a hallucinated name instead of
    // burning a turn — the model must use the declared pair.
    if (anchorBootstrapping(ctx.model) && anchorRunActive) {
      if (!BOOTSTRAP_TOOLS.includes(event.toolName)) {
        return { block: true, reason: `steering: ${event.toolName} is unavailable during the bootstrap request; use bash or str_replace_editor (command: "view" to read files).` };
      }
      return;
    }

    // A Serena call is the behavior we steer TOWARD — re-arm the per-turn latch.
    if (event.toolName.startsWith("serena_")) { remindedThisTurn = false; return; }

    // Steering is DeepSeek-only (GLM doesn't need it per eval).
    if (f !== "deepseek-v4") return;

    const activeTools = pi.getActiveTools();
    const serenaActive = activeTools.some((t) => t.startsWith("serena_"));
    const semanticMiss = serenaActive && isSemanticMissToolCall(event.toolName, event.input);
    const dedicatedTool = missedDedicatedTool(event.toolName, event.input, activeTools);
    if (!semanticMiss && !dedicatedTool) return;

    const reason = semanticMiss
      ? "For DeepSeek V4, use Serena semantic tools for code-symbol work."
      : `For DeepSeek V4, use the dedicated ${dedicatedTool} tool instead of bash.`;

    if (semanticMiss) {
      const suggest = suggestBestSerenaCommand(event.input, activeTools);
      // grep/ffgrep are first-class search tools — NEVER hard-block them. Emit a
      // non-blocking steer so the model can still switch to Serena when useful.
      // Only SIMPLE bash symbol searches (semanticMiss on bash) hard-block.
      if (event.toolName === "grep" || event.toolName === "ffgrep") {
        if (remindedThisTurn) return;
        remindedThisTurn = true;
        pi.sendMessage({ customType: STEERING_MESSAGE_TYPE, content: `${reason} ${suggest}`, display: true }, { deliverAs: "steer" });
        return;
      }
      return { block: true, reason: `${reason} ${suggest}` };
    }

    // Dedicated-tool miss (bash where ls/find/ffind/grep/ffgrep/read/write would
    // do): non-strict = one reminder per turn. Strict escalates a REPEATED miss
    // for the same tool to a block at the fixed reminder count — the upstream
    // env knob is gone (see BLOCK_AFTER_REMINDERS).
    if (settings.strictSerena) {
      const missKey = `bash→${dedicatedTool}`;
      const count = (reminderCounts.get(missKey) ?? 0) + 1;
      reminderCounts.set(missKey, count);
      if (count >= BLOCK_AFTER_REMINDERS) return { block: true, reason: `${reason} (blocked after ${count} reminders — strict Serena mode)` };
    }
    if (remindedThisTurn) return;
    remindedThisTurn = true;
    pi.sendMessage({ customType: STEERING_MESSAGE_TYPE, content: `${reason} Use bash for real commands only.`, display: true }, { deliverAs: "steer" });
  });
}
