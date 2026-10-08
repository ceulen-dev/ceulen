/**
 * plan — read-only plan mode for ceulen.
 *
 * Ported from @bacnh85/pi-plan 0.16.6 (extensions/modules/plan/), reduced to
 * the permission + review gate: mode toggle, tool gating, write_plan,
 * ask_user_question, plan model/thinking, approval handoff, and the
 * save-plans policy. Dropped from upstream (ceulen covers them elsewhere or
 * pi's API cannot express them): the implement→verify→review flow (subagent
 * worktree + advisor cover the loop), /rewind, /goal, /specs, /handoff, /btw,
 * /doctor, the fallback chain (advisor module), and the Jev plan gate
 * (classifier module notes tool_call can only block, never approve in
 * pi 1.0.0).
 *
 * Plan files: `<repo>/.pi/plans/<timestamp>-<slug>.md` by default; the
 * `plan.savePlans` setting decides WHICH plans hit disk — `all` (every
 * write_plan), `approved` (drafts stay in memory, the file is written at
 * approval), `none` (never). /config → Tasks → Plan mode edits it all.
 *
 * Registration surface: /plan (toggle), /plan-approve (current|new),
 * /plan-model, /plan-thinking, /plan-auto, the --plan flag, ctrl+alt+p,
 * tools write_plan + ask_user_question, and the shared state entry type.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { isToolCallEventType, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { classifyCommand, probeDiffDrivers } from "./lib/shell-gate.js";import {
  BLOCKED_TOOLS,
  extractSubagentNames,
  INTERPRETER_TOKENS,
  READ_ONLY_TOOLS,
} from "./lib/plan-tools.js";
import { buildPlanModePrompt } from "./lib/prompt.js";
import {
  DEFAULT_PLANS_DIR,
  expandPlansDir,
  isInsidePlansDir,
  isThinkingLevel,
  planPath,
  readPlanSettings,
  relativeToCwd,
  writePlanSection,
  THINKING_LEVELS,
  type PlanSettings,
  type ThinkingLevel,
} from "./lib/settings.js";
import { getPlanRegistry, planConfig, setPlanBridge, setPlanRegistry, type PlanBridge } from "./configPanel.js";
import { askJev, audit, getLastTask, isRisky, noul, segments } from "../classifier/index.js";
import { getClassifierSettings } from "../classifier/lib/settings.js";
// Sandbox semantics live in ONE place: the subagent module resolves agent
// frontmatter (user + project + bundled). discoverAgents is a pure fs loader,
// independent of whether the subagent module itself is enabled.
import { discoverAgents } from "../subagent/lib/agents.js";
import { setPlanActive } from "../../lib/plan-bridge.ts";

export const PLAN_STATUS_KEY = "ceulen-plan";
export const PLAN_ENTRY_TYPE = "ceulen-plan";
export const PLAN_TOOL = "write_plan";
export const ASK_USER_QUESTION_TOOL = "ask_user_question";

// ── planGate (classifier.planGate) ──────────────────────────────────────────
// The classifier can move a CONFIRM-tier bash command to auto-run when Jev
// says it clearly doesn't mutate and serves the task. It can never do the
// reverse: write stays a hard block, read stays auto. Off by default — run
// `planGate.observe` first and read the ceulen-plan-gate lines in
// classifier.log before flipping enabled.

// ponytail: value of classifier's CLASSIFIER_HOOK_BUDGET_MS — the constant is
// module-private and importing it would be module state, not a value.
const PLAN_GATE_BUDGET_MS = 2_500;

interface PlanGateVerdict {
  mutates: number;
  reversible: number;
  serves: number;
  safe: boolean;
}

/** Ask Jev about a confirm-tier command. Returns undefined on any failure —
 *  the confirm tier is the unchanged fallback. Exported for tests. */
export async function planGateVerdict(command: string, ctx: ExtensionContext): Promise<PlanGateVerdict | undefined> {
  const task = getLastTask();
  const state: Record<string, unknown> = { command, project_path: ctx.cwd, ...(task ? { task } : {}) };
  const questions: Record<string, unknown> = {
    mutates_filesystem: {
      type: "bool",
      instructions: "Does this command modify files or state outside the shell's own process?",
      criteria: { yes: "Writes, deletes, moves, installs, or otherwise changes persistent state.", no: "Purely observational — reads, lists, searches, prints." },
    },
    reversible: {
      type: "bool",
      instructions: "If it DID have an effect, could that effect be undone or discarded without lasting harm?",
    },
    ...(task
      ? {
          serves_task: {
            type: "bool",
            instructions: "Does this command plausibly serve the task the user asked for?",
            criteria: { yes: "A reasonable step toward the user's stated task.", no: "Unrelated to the task, or only a step the task never needed." },
          },
        }
      : {}),
  };
  const started = Date.now();
  try {
    const budget = AbortSignal.timeout(PLAN_GATE_BUDGET_MS);
    const answers = (await Promise.race([
      askJev(ctx, state, questions, budget),
      new Promise<never>((_, reject) => budget.addEventListener("abort", () => reject(new Error("plan gate budget exceeded")), { once: true })),
    ])) as Record<string, unknown>;
    const mutates = noul(answers, "mutates_filesystem");
    const reversible = noul(answers, "reversible");
    const serves = task ? noul(answers, "serves_task") : reversible; // no task → serve check degenerates
    const { planGate } = getClassifierSettings();
    const safe = Number.isFinite(mutates) && mutates < 0.2 && Number.isFinite(reversible) && reversible >= planGate.threshold && serves >= planGate.threshold;
    await audit({
      tag: "ceulen-plan-gate",
      command,
      mutates_filesystem: Number.isFinite(mutates) ? mutates : null,
      reversible: Number.isFinite(reversible) ? reversible : null,
      serves_task: Number.isFinite(serves) ? serves : null,
      safe,
      observe: planGate.observe,
      enforcing: planGate.enabled,
      ms: Date.now() - started,
    });
    return { mutates, reversible, serves, safe };
  } catch (e) {
    await audit({ tag: "ceulen-plan-gate", command, error: String(e instanceof Error ? e.message : e), ms: Date.now() - started });
    return undefined;
  }
}

/** Returns true when the gate auto-runs the command (only possible when
 *  planGate.enabled); undefined → fall through to the normal confirm tier. */
async function planGateAutoRun(command: string, ctx: ExtensionContext): Promise<boolean | undefined> {
  const { planGate } = getClassifierSettings();
  if (!planGate.enabled && !planGate.observe) return undefined;
  // Static risk list first — credential/irreversible shapes never reach Jev
  // and never leave the normal confirm tier. The whole command AND its
  // segments: the pipe-to-shell regexes need the unsplit command, while
  // segments expose risky commands hidden after && / ;.
  if (isRisky(command) || segments(command).some(isRisky)) return undefined;
  const verdict = await planGateVerdict(command, ctx);
  if (verdict?.safe && planGate.enabled) {
    if (ctx.hasUI) {
      try {
        ctx.ui.notify(`plan gate: auto-allowed (${command.slice(0, 80)})`, "info");
      } catch {
        /* non-tui */
      }
    }
    return true;
  }
  return undefined;
}

/** Persisted plan-mode session state (branch-scoped via appendEntry). */
export interface PlanState {
  enabled: boolean;
  toolsBeforePlan?: string[];
  lastPlanPath?: string;
  lastPlanTitle?: string;
  /** Plan content for the savePlans=approved|none paths (file deferred/absent). */
  lastPlanContent?: string;
  /** The current plan was approved+handed off — the next entry starts fresh. */
  planApproved?: boolean;
  planReadyForReview?: boolean;
  prePlanModel?: string;
  prePlanThinking?: ThinkingLevel;
}

interface WritePlanParams {
  title?: string;
  content: string;
}

interface PlanQuestionOption {
  label: string;
  description?: string;
}

interface PlanQuestionParams {
  question: string;
  options: PlanQuestionOption[];
  recommended?: string;
  allowOther?: boolean;
}

function deriveTitle(content: string): string | undefined {
  return content.match(/^#\s+(.+)$/m)?.[1]?.trim() || undefined;
}

function normalizePlanContent(title: string, content: string): string {
  const body = content.trim();
  if (/^#\s+/m.test(body)) return `${body}\n`;
  return `# ${title}\n\n${body}\n`;
}

function splitModelRef(ref: string): { provider: string; id: string } | undefined {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return undefined;
  return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

function currentModelRef(ctx: ExtensionContext): string | undefined {
  return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

function formatShortContextUsage(ctx: ExtensionContext): string {
  const usage = ctx.getContextUsage();
  return usage?.percent === null || usage?.percent === undefined
    ? "Context unknown."
    : `Context: ${Math.round(usage.percent)}% used.`;
}

function clip(s: string): string {
  return s.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
}

/** Build the execution prompt for the approved plan. */
export function buildExecutionPrompt(relativePlan: string, mode: "current" | "new"): string {
  const prefix = mode === "new" ? "This is a fresh session created from an approved plan. " : "";
  const where = relativePlan ? ` at ${relativePlan}` : " above";
  return `${prefix}Execute the approved plan${where}. Read the plan file if needed, keep the implementation scoped to the plan, update it if reality differs materially, and run the verification described there.`;
}

/** Read the last persisted plan-mode entry on a branch. Exported for tests. */
export function resolvePlanState(entries: unknown): PlanState | undefined {
  if (!Array.isArray(entries)) return undefined;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i] as { type?: string; customType?: string; data?: PlanState } | undefined;
    if (entry?.type !== "custom" || entry?.customType !== PLAN_ENTRY_TYPE) continue;
    return entry.data && typeof entry.data === "object" ? entry.data : { enabled: false };
  }
  return undefined;
}

export default function planModule(pi: ExtensionAPI): void {
  let planModeEnabled = false;
  let settings: PlanSettings = readPlanSettings();
  let liveCwd = process.cwd();
  let liveTrusted = false;
  /** Session-scoped allow list from the confirm tier. Keyed by tool name or
   *  `bash:<first token>` / `bash-cmd:<full command>`; cleared on mode toggle. */
  const sessionAllows = new Set<string>();
  let toolsBeforePlan: string[] | undefined;
  let prePlanModel: string | undefined;
  let prePlanThinking: ThinkingLevel | undefined;
  let lastPlanPath: string | undefined;
  let lastPlanTitle: string | undefined;
  let lastPlanContent: string | undefined;
  /** Set when the current plan was approved+handed off — the next plan-mode
   *  entry starts fresh instead of reusing the stale path/title. */
  let planApproved = false;
  let planReadyForReview = false;
  let applyingStoredModel = false;
  let writePlanInProgress = false;
  const planToolsAvailable = (): string[] => [PLAN_TOOL, ASK_USER_QUESTION_TOOL];

  // ── State / settings ────────────────────────────────────────

  function refreshSettings(ctx?: ExtensionContext): void {
    if (ctx) {
      liveCwd = ctx.cwd ?? liveCwd;
      try { liveTrusted = ctx.isProjectTrusted?.() === true; } catch { liveTrusted = false; }
    }
    settings = readPlanSettings({ cwd: liveCwd, isProjectTrusted: () => liveTrusted });
  }

  /** Persist the working settings to the global `plan` section. */
  /** Write ONE plan key to the GLOBAL settings file — never the merged
   *  snapshot: a project-overlay value must not be promoted to global, and
   *  a full write would resurrect stale siblings over concurrent edits. */
  function persistSettings(patch: Partial<PlanSettings>): void {
    writePlanSection(patch);
  }

  function persistState(): void {
    pi.appendEntry(PLAN_ENTRY_TYPE, {
      enabled: planModeEnabled,
      toolsBeforePlan,
      lastPlanPath,
      lastPlanTitle,
      lastPlanContent,
      planApproved,
      planReadyForReview,
      prePlanModel,
      prePlanThinking,
    } satisfies PlanState);
  }

  function updateStatus(ctx: ExtensionContext): void {
    ctx.ui.setStatus(PLAN_STATUS_KEY, planModeEnabled ? ctx.ui.theme.fg("accent", "Plan mode") : undefined);
    // Publish for the permission module (plan-bridge) — updateStatus runs after
    // EVERY planModeEnabled assignment site, so this one line covers toggle,
    // session restore, startup flag, and exit-for-execution.
    setPlanActive(planModeEnabled);
  }

  /** Restore branch-scoped state (session_start / session_tree). */
  function restoreStateFromBranch(ctx: ExtensionContext): void {
    const saved = resolvePlanState(ctx.sessionManager.getBranch());
    if (!saved) {
      planModeEnabled = false;
      toolsBeforePlan = undefined;
      lastPlanPath = undefined;
      lastPlanTitle = undefined;
      lastPlanContent = undefined;
      planApproved = false;
      planReadyForReview = false;
      prePlanModel = undefined;
      prePlanThinking = undefined;
      return;
    }
    planModeEnabled = saved.enabled ?? false;
    toolsBeforePlan = saved.toolsBeforePlan;
    lastPlanPath = saved.lastPlanPath;
    lastPlanTitle = saved.lastPlanTitle;
    lastPlanContent = saved.lastPlanContent;
    planApproved = saved.planApproved === true;
    planReadyForReview = saved.planReadyForReview === true;
    prePlanModel = typeof saved.prePlanModel === "string" ? saved.prePlanModel : undefined;
    prePlanThinking = typeof saved.prePlanThinking === "string" && isThinkingLevel(saved.prePlanThinking) ? saved.prePlanThinking : undefined;
  }

  // ── Tool set ────────────────────────────────────────────────

  /** Enter plan mode: keep active read tools, add the plan tools, strip mutators. */
  function enablePlanTools(): void {
    const baseline = [...new Set([...(toolsBeforePlan ?? pi.getActiveTools()), ...planToolsAvailable()])];
    toolsBeforePlan = baseline;
    pi.setActiveTools(baseline.filter((t) => !BLOCKED_TOOLS.has(t)));
  }

  function restoreTools(): void {
    if (toolsBeforePlan) pi.setActiveTools(toolsBeforePlan);
    toolsBeforePlan = undefined;
  }

  // ── Plan model / thinking ───────────────────────────────────

  function applyThinking(level: ThinkingLevel): void {
    try {
      pi.setThinkingLevel(level);
    } catch {
      /* model clamp / unknown level — keep the current one */
    }
  }

  /** Apply the configured plan model + thinking. Only called while plan mode is
   *  active; records the pre-plan model/thinking once so leaving plan mode
   *  restores stock Pi behavior (in-plan /model picks stay session-temporary). */
  async function applyPlanModeConfig(ctx: ExtensionContext): Promise<void> {
    if (!planModeEnabled) return;
    if (prePlanModel === undefined) prePlanModel = currentModelRef(ctx);
    if (prePlanThinking === undefined) prePlanThinking = pi.getThinkingLevel() as ThinkingLevel;

    const target = settings.planModel;
    if (target) {
      const parsed = splitModelRef(target);
      const model = parsed ? ctx.modelRegistry.find(parsed.provider, parsed.id) : undefined;
      if (!model) {
        if (target !== currentModelRef(ctx)) {
          ctx.ui.notify(`Plan model not loaded yet: ${target} — keeping the current model.`, "warning");
        }
      } else if (target !== currentModelRef(ctx)) {
        applyingStoredModel = true;
        try {
          const ok = await pi.setModel(model);
          if (!ok) ctx.ui.notify(`No API key for ${target}; plan model switch skipped.`, "warning");
        } catch (error) {
          ctx.ui.notify(`Plan model switch failed: ${String(error)}`, "warning");
        } finally {
          applyingStoredModel = false;
        }
      }
    }
    if (settings.planThinking && isThinkingLevel(settings.planThinking)) applyThinking(settings.planThinking);
  }

  async function restorePrePlanModel(ctx: ExtensionContext): Promise<void> {
    if (!prePlanModel || prePlanModel === currentModelRef(ctx)) return;
    const parsed = splitModelRef(prePlanModel);
    const model = parsed ? ctx.modelRegistry.find(parsed.provider, parsed.id) : undefined;
    if (!model) {
      prePlanModel = undefined;
      return;
    }
    applyingStoredModel = true;
    try { await pi.setModel(model); } catch { /* keep current */ }
    finally { applyingStoredModel = false; }
    prePlanModel = undefined;
  }

  function restorePrePlanThinking(): void {
    if (prePlanThinking && pi.getThinkingLevel() !== prePlanThinking) applyThinking(prePlanThinking);
    prePlanThinking = undefined;
  }

  async function restorePrePlan(ctx: ExtensionContext): Promise<void> {
    await restorePrePlanModel(ctx);
    restorePrePlanThinking();
  }

  // ── Mode toggle ─────────────────────────────────────────────

  async function enterPlanMode(ctx: ExtensionContext): Promise<void> {
    planModeEnabled = true;
    sessionAllows.clear();
    refreshSettings(ctx);
    // A previously approved plan must not leak into a new planning session;
    // an unapproved draft survives a toggle-off/toggle-on so refinement works.
    if (planApproved) {
      lastPlanPath = undefined;
      lastPlanTitle = undefined;
      lastPlanContent = undefined;
      planApproved = false;
    }
    planReadyForReview = false;
    enablePlanTools();
    await applyPlanModeConfig(ctx);
    updateStatus(ctx);
    persistState();
    ctx.ui.notify(`Plan mode enabled. Plans directory: ${expandPlansDir(settings.plansDir)}/`, "info");
  }

  async function leavePlanMode(ctx: ExtensionContext): Promise<void> {
    planModeEnabled = false;
    planReadyForReview = false;
    sessionAllows.clear();
    restoreTools();
    await restorePrePlan(ctx);
    updateStatus(ctx);
    persistState();
    ctx.ui.notify("Plan mode disabled.", "info");
  }

  async function togglePlanMode(ctx: ExtensionContext): Promise<void> {
    if (planModeEnabled) await leavePlanMode(ctx);
    else await enterPlanMode(ctx);
  }

  // ── write_plan ──────────────────────────────────────────────

  async function writePlanFile(destination: string, content: string): Promise<void> {
    await withFileMutationQueue(destination, async () => {
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, content, "utf8");
    });
  }

  async function executeWritePlan(params: WritePlanParams, ctx: ExtensionToolContext) {
    if (writePlanInProgress) throw new Error("write_plan is already in progress, wait for completion before calling again.");
    writePlanInProgress = true;
    try {
      refreshSettings(ctx);
      const title = params.title?.trim() || deriveTitle(params.content) || "Plan";
      const content = normalizePlanContent(title, params.content);

      // Refinement of the same draft reuses its path (containment-checked).
      const reusable = lastPlanPath && lastPlanTitle === title && isInsidePlansDir(path.resolve(ctx.cwd, lastPlanPath), settings.plansDir, ctx.cwd)
        ? path.resolve(ctx.cwd, lastPlanPath)
        : undefined;
      const destination = reusable ?? planPath(ctx.cwd, title, settings.plansDir);

      if (settings.savePlans === "all") await writePlanFile(destination, content);
      lastPlanPath = destination;
      lastPlanTitle = title;
      lastPlanContent = content;
      planReadyForReview = true;
      persistState();

      const where = settings.savePlans === "none"
        ? "kept in this conversation only (plan.savePlans = none)"
        : settings.savePlans === "approved"
          ? `held for approval — the file is written to ${relativeToCwd(ctx.cwd, destination)} once approved`
          : `written to ${relativeToCwd(ctx.cwd, destination)}`;
      const tail = settings.autoApprove
        ? "Autonomous approval is armed: execution starts automatically."
        : `The plan is ready for approval: stop and tell the user — /plan-approve is prefilled and the user presses Enter to choose current-session or fresh-session execution. Do not use ${ASK_USER_QUESTION_TOOL} to offer approve/execute options.`;
      return {
        content: [{ type: "text" as const, text: `Plan ${where}. ${tail}` }],
        details: { path: settings.savePlans === "none" ? undefined : destination, title, savePlans: settings.savePlans },
      };
    } finally {
      writePlanInProgress = false;
    }
  }

  // ── ask_user_question ───────────────────────────────────────

  /** Validate ask_user_question params. Throws on invalid input. */
  function validateQuestionParams(typedParams: PlanQuestionParams): { options: PlanQuestionOption[]; recommendedIndex: number | null } {
    const options = typedParams.options ?? [];
    const labels = options.map((o) => o.label.trim());
    if (labels.some((l) => !l)) throw new Error("Each option must have a non-blank label.");
    if (new Set(labels).size !== labels.length) throw new Error("Option labels must be unique.");
    if (labels.some((l) => l.toLowerCase() === "other" || l.toLowerCase().startsWith("other "))) {
      throw new Error('Option labels cannot conflict with the "Other" label.');
    }
    let recommendedIndex: number | null = null;
    if (typedParams.recommended) {
      const recTrim = typedParams.recommended.trim();
      const matchIdx = labels.findIndex((l) => l.toLowerCase() === recTrim.toLowerCase());
      if (matchIdx === -1) throw new Error("recommended must match one of the option labels.");
      recommendedIndex = matchIdx;
    }
    return { options, recommendedIndex };
  }

  // ponytail: ctx.ui.select is not reentrant — serialize concurrent dialogs.
  let askQuestionQueue: Promise<unknown> = Promise.resolve();

  async function executeAskQuestion(_toolCallId: string, params: unknown, _signal: unknown, _onUpdate: unknown, ctx: ExtensionToolContext) {
    const typedParams = params as PlanQuestionParams;
    const { options, recommendedIndex } = validateQuestionParams(typedParams);
    const textBlock = (text: string) => ({ type: "text" as const, text });
    const cancelled = {
      content: [textBlock("User cancelled the question.")],
      details: { question: typedParams.question, options, answer: null, cancelled: true, wasCustom: false },
    };

    if (!ctx.hasUI) {
      return {
        content: [textBlock("UI is not available. Ask this question directly in chat and wait for the user's answer.")],
        details: { question: typedParams.question, options, answer: null, wasCustom: false, cancelled: false },
      };
    }
    const allowOther = typedParams.allowOther !== false;
    const displayLabels = options.map((option, i) => {
      const star = recommendedIndex !== null && i === recommendedIndex && options.length > 1 ? "★ " : "";
      return option.description ? `${star}${option.label} — ${option.description}` : `${star}${option.label}`;
    });
    const otherLabel = "Other / type my answer";
    const choice = await ctx.ui.select(typedParams.question, allowOther ? [...displayLabels, otherLabel] : displayLabels);
    if (!choice) return cancelled;

    if (choice === otherLabel) {
      const answer = (await ctx.ui.editor("Your answer", ""))?.trim();
      if (!answer) return cancelled;
      return {
        content: [textBlock(`User wrote: ${answer}`)],
        details: { question: typedParams.question, options, answer, wasCustom: true, cancelled: false },
      };
    }
    const selectedIndex = displayLabels.indexOf(choice);
    const answer = options[selectedIndex]?.label ?? choice;
    return {
      content: [textBlock(`User selected: ${answer}`)],
      details: { question: typedParams.question, options, answer, selectedIndex, wasCustom: false, cancelled: false },
    };
  }

  function executeAskQuestionQueued(toolCallId: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: ExtensionToolContext) {
    const run = () => executeAskQuestion(toolCallId, params, signal, onUpdate, ctx);
    const result = askQuestionQueue.then(run, run);
    askQuestionQueue = result.catch(() => {});
    return result;
  }

  // ── Approval ────────────────────────────────────────────────

  /** Persist a deferred (savePlans=approved) plan right before execution. */
  async function materializePlan(): Promise<void> {
    if (settings.savePlans !== "approved") return;
    if (!lastPlanPath || !lastPlanContent) return;
    await writePlanFile(lastPlanPath, lastPlanContent);
  }

  /** Exit plan mode for execution and return the plan's relative path ("" for
   *  the never-persisted policy). */
  async function exitPlanForExecution(ctx: ExtensionContext): Promise<string> {
    const relativePlan = lastPlanPath && settings.savePlans !== "none" ? relativeToCwd(ctx.cwd, lastPlanPath) : "";
    planModeEnabled = false;
    planApproved = true;
    planReadyForReview = false;
    sessionAllows.clear();
    restoreTools();
    await restorePrePlan(ctx);
    updateStatus(ctx);
    persistState();
    return relativePlan;
  }

  /** Approve + execute in the current session. Shared by /plan-approve and
   *  the auto-approve settle path (no command context needed). */
  async function executeInCurrentSession(ctx: ExtensionContext): Promise<void> {
    await materializePlan();
    const relativePlan = await exitPlanForExecution(ctx);
    pi.sendUserMessage(buildExecutionPrompt(relativePlan, "current"), { deliverAs: "followUp" });
  }

  /** Approve + hand the plan to a fresh session (command context only:
   *  newSession() is a command API). */
  async function executeInNewSession(ctx: ExtensionCommandContext): Promise<void> {
    if (!lastPlanPath || !lastPlanContent) {
      ctx.ui.notify("No approved plan is available to execute.", "error");
      return;
    }
    await materializePlan();
    const relativePlan = await exitPlanForExecution(ctx);
    const parentSession = ctx.sessionManager.getSessionFile();
    // planApproved: the handed-off plan must NOT be reused as a draft when
    // plan mode is entered again in the child session.
    const state: PlanState = { enabled: false, lastPlanPath, lastPlanTitle, lastPlanContent, planApproved: true, planReadyForReview: false };
    await ctx.waitForIdle();
    const result = await ctx.newSession({
      parentSession,
      setup: async (sessionManager) => { sessionManager.appendCustomEntry(PLAN_ENTRY_TYPE, state); },
      withSession: async (replacementCtx) => { await replacementCtx.sendUserMessage(buildExecutionPrompt(relativePlan, "new")); },
    });
    if (result.cancelled) ctx.ui.notify("New-session execution cancelled.", "info");
  }

  async function handlePlanApproval(args: string, ctx: ExtensionCommandContext): Promise<void> {
    if (!lastPlanContent) {
      ctx.ui.notify("No plan is ready for approval.", "warning");
      return;
    }
    let mode = args.trim().toLowerCase();
    if (!mode) {
      if (!ctx.hasUI) {
        ctx.ui.notify("Usage: /plan-approve current|new", "warning");
        return;
      }
      const currentChoice = "Implement in current session";
      const newChoice = `Clear context and implement · ${formatShortContextUsage(ctx)}`;
      const stayChoice = "Stay in Plan mode";
      const choice = await ctx.ui.select("Implement this plan?", [currentChoice, newChoice, stayChoice]);
      if (!choice || choice === stayChoice) return;
      mode = choice === currentChoice ? "current" : "new";
    }
    if (mode !== "current" && mode !== "new") {
      ctx.ui.notify("Usage: /plan-approve current|new", "warning");
      return;
    }
    if (mode === "new" && settings.savePlans === "none") {
      ctx.ui.notify("plan.savePlans = none keeps plans out of the repository — fresh-session execution needs a plan file. Use current-session execution or change plan.savePlans.", "warning");
      return;
    }
    if (mode === "current") await executeInCurrentSession(ctx);
    else await executeInNewSession(ctx);
  }

  // ── Confirm tier ────────────────────────────────────────────

  async function planApprovalPrompt(ctx: ExtensionContext, title: string, detail: string, rememberKey: string): Promise<string | undefined> {
    const choice = await ctx.ui.select(`${title}\n\n${detail}`, ["Allow once", "Allow for this session", "Deny"]);
    if (choice === "Allow for this session") {
      sessionAllows.add(rememberKey);
      return undefined;
    }
    if (choice === undefined || choice === "Deny") return `${title.replace(/ in plan mode\?$/, "")} rejected by user.`;
    return undefined; // Allow once
  }

  /** True when every named subagent resolves to a read-only sandbox. */
  function subagentsReadOnly(names: string[], cwd: string): boolean {
    try {
      const { agents } = discoverAgents(cwd, "both", path.resolve(import.meta.dirname, "../subagent/agents"));
      return names.length > 0 && names.every((name) => agents.find((a) => a.name === name)?.sandbox === "read-only");
    } catch {
      return false; // fail closed → confirm tier
    }
  }

  // ── Registration ────────────────────────────────────────────

  pi.registerFlag("plan", {
    description: "Start in ceulen plan mode (read-only planning)",
    type: "boolean",
    default: false,
  });

  pi.registerTool({
    name: PLAN_TOOL,
    label: "Write Plan",
    description: `Write/replace a plan as Markdown under the configured plans directory (default ${DEFAULT_PLANS_DIR}/). Use when the plan is ready for review.`,
    promptSnippet: `Write the plan under ${DEFAULT_PLANS_DIR}/ as Markdown for user review`,
    promptGuidelines: [
      `Use ${PLAN_TOOL} in plan mode after exploration. No edit/write until the plan is approved.`,
      `Don't call ${PLAN_TOOL} while blocking questions remain; use ${ASK_USER_QUESTION_TOOL} first.`,
    ],
    parameters: Type.Object({
      title: Type.Optional(Type.String({ description: "Short plan title. Optional: derived from the first '# Heading' in content when omitted." })),
      content: Type.String({ description: "Markdown plan content" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return executeWritePlan(params as WritePlanParams, ctx);
    },
  });

  pi.registerTool({
    name: ASK_USER_QUESTION_TOOL,
    label: "Ask User Question",
    description: "Ask the user a clarifying question with selectable options, a recommended default, and optional free-form input. Works in any mode.",
    promptSnippet: "Ask the user a clarifying question with 2-4 options and a recommended default; works in any mode",
    promptGuidelines: [
      "Use only when repo research leaves a consequential ambiguity.",
      "Prefer 2-4 concrete options. Use short labels.",
      "Don't ask what's discoverable from the repo.",
      "Respect the user's stated preference.",
      "Provide a recommended option when one choice is clearly preferable.",
      `Never issue multiple ${ASK_USER_QUESTION_TOOL} calls in the same turn — ask one question, await the answer, then decide.`,
    ],
    parameters: Type.Object({
      question: Type.String({ description: "Question to ask the user" }),
      options: Type.Array(
        Type.Object({
          label: Type.String({ description: "Option label" }),
          description: Type.Optional(Type.String({ description: "Optional explanation" })),
        }),
        { description: "Options to choose from (2-4 required)", minItems: 2, maxItems: 4 },
      ),
      recommended: Type.Optional(Type.String({ description: "Label of the recommended option (must match one option label). It is shown with a ★ marker." })),
      allowOther: Type.Optional(Type.Boolean({ description: "Allow free-form user answer; default true" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return executeAskQuestionQueued(toolCallId, params, signal, onUpdate, ctx);
    },
  });

  pi.registerCommand("plan", {
    description: "Toggle ceulen plan mode (read-only planning)",
    handler: async (args, ctx) => {
      if (args.trim().length > 0) {
        ctx.ui.notify("/plan does not take arguments; use /plan to toggle plan mode.", "warning");
        return;
      }
      await togglePlanMode(ctx);
    },
  });

  pi.registerCommand("plan-approve", {
    description: "Approve the current plan for current-session or fresh-session execution",
    getArgumentCompletions: (prefix) => {
      const items = ["current", "new"]
        .filter((k) => k.startsWith(prefix.trim().toLowerCase()))
        .map((k) => ({ value: k, label: k }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => handlePlanApproval(args, ctx),
  });

  pi.registerCommand("plan-model", {
    description: "Set the plan-mode model (global); normal mode follows Pi's own /model",
    getArgumentCompletions: (prefix) => {
      const q = prefix.trim().toLowerCase();
      const refs = (getPlanRegistry()?.getAvailable() ?? []).map((m) => `${m.provider}/${m.id}`);
      const items = [...["clear"].filter((k) => k.startsWith(q)), ...refs.filter((r) => r.toLowerCase().includes(q))]
        .slice(0, 25)
        .map((v) => ({ value: v, label: v }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      refreshSettings(ctx);
      const trimmed = args.trim();
      if (trimmed.toLowerCase() === "clear") {
        if (!settings.planModel) return ctx.ui.notify("No plan model configured.", "info");
        settings.planModel = "";
        persistSettings({ planModel: "" });
        if (planModeEnabled) await restorePrePlanModel(ctx);
        ctx.ui.notify("Plan model cleared — plan mode follows the active model.", "info");
        persistState();
        return;
      }
      if (!trimmed) {
        ctx.ui.notify(`plan model=${settings.planModel || "-"} · thinking=${settings.planThinking || "-"} · active=${currentModelRef(ctx) ?? "-"}`, "info");
        return;
      }
      const find = () => ctx.modelRegistry.getAvailable().find((m) => `${m.provider}/${m.id}`.toLowerCase() === trimmed.toLowerCase());
      let model = find();
      if (!model) {
        try { await ctx.modelRegistry.refresh(); } catch { /* use cached models */ }
        model = find();
      }
      if (!model) return ctx.ui.notify(`No model matching "${trimmed}". Use provider/id.`, "warning");
      settings.planModel = `${model.provider}/${model.id}`;
      persistSettings({ planModel: settings.planModel });
      if (planModeEnabled) await applyPlanModeConfig(ctx);
      ctx.ui.notify(`Plan model set: ${settings.planModel}${planModeEnabled ? "" : " (applies in plan mode)"}`, "info");
      persistState();
    },
  });

  pi.registerCommand("plan-thinking", {
    description: "Set the plan-mode thinking level (global); normal mode follows Pi's own /thinking",
    getArgumentCompletions: (prefix) => {
      const items = [...THINKING_LEVELS, "clear"].filter((k) => k.startsWith(prefix.trim().toLowerCase())).map((k) => ({ value: k, label: k }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      refreshSettings(ctx);
      const trimmed = args.trim();
      if (trimmed.toLowerCase() === "clear") {
        if (!settings.planThinking) return ctx.ui.notify("No plan thinking level configured.", "info");
        settings.planThinking = "";
        persistSettings({ planThinking: "" });
        ctx.ui.notify("Plan thinking level cleared.", "info");
        persistState();
        return;
      }
      if (!trimmed) {
        ctx.ui.notify(`plan thinking=${settings.planThinking || "-"} · active=${pi.getThinkingLevel()}`, "info");
        return;
      }
      if (!isThinkingLevel(trimmed)) {
        ctx.ui.notify(`Invalid thinking level: ${trimmed}. Levels: ${THINKING_LEVELS.join(", ")}.`, "warning");
        return;
      }
      settings.planThinking = trimmed;
      persistSettings({ planThinking: trimmed });
      if (planModeEnabled) applyThinking(trimmed);
      ctx.ui.notify(`Plan thinking level set: ${trimmed}${planModeEnabled ? "" : " (applies in plan mode)"}`, "info");
      persistState();
    },
  });

  pi.registerCommand("plan-auto", {
    description: "Arm autonomous approval: /plan-auto [on|off|status] — a written plan executes without a keypress",
    getArgumentCompletions: (prefix) => {
      const items = ["on", "off", "status"].filter((k) => k.startsWith(prefix.trim().toLowerCase())).map((k) => ({ value: k, label: k }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      refreshSettings(ctx);
      const arg = args.trim().toLowerCase();
      if (arg && arg !== "on" && arg !== "off" && arg !== "status") {
        ctx.ui.notify("Usage: /plan-auto [on|off|status]", "warning");
        return;
      }
      if (arg === "status") {
        ctx.ui.notify(`auto-approve: ${settings.autoApprove ? "on" : "off"} · save plans: ${settings.savePlans} · dir: ${expandPlansDir(settings.plansDir)}`, "info");
        return;
      }
      settings.autoApprove = arg !== "off";
      persistSettings({ autoApprove: settings.autoApprove });
      // Bare /plan-auto arms and enters plan mode — the practical entry point.
      if (!arg && settings.autoApprove && !planModeEnabled) {
        await enterPlanMode(ctx);
        ctx.ui.notify("Autonomous approval armed. Describe the task — the plan is executed without a keypress.", "info");
        return;
      }
      ctx.ui.notify(settings.autoApprove ? "Autonomous approval armed: the next written plan executes without a keypress." : "Autonomous approval disarmed.", "info");
    },
  });

  pi.registerShortcut("ctrl+alt+p", {
    description: "Toggle ceulen plan mode",
    handler: async (ctx) => togglePlanMode(ctx),
  });

  // ── Events ──────────────────────────────────────────────────

  pi.on("session_start", async (event, ctx) => {
    sessionAllows.clear();
    refreshSettings(ctx);
    setPlanRegistry(ctx.modelRegistry);
    void probeDiffDrivers(ctx.cwd); // best-effort: textconv-aware bash gating
    restoreStateFromBranch(ctx);

    // The plan tools must always be visible (unless per-tool kill-switched).
    const active = pi.getActiveTools();
    const additions = planToolsAvailable().filter((t) => !active.includes(t));
    if (additions.length) pi.setActiveTools([...active, ...additions]);

    if (event.reason === "startup" && pi.getFlag("plan") === true) planModeEnabled = true;
    if (planModeEnabled) {
      enablePlanTools();
      await applyPlanModeConfig(ctx);
    }
    updateStatus(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    const previousToolsBeforePlan = toolsBeforePlan;
    const wasPlan = planModeEnabled;
    const preModel = prePlanModel;
    const preThinking = prePlanThinking;
    restoreStateFromBranch(ctx);
    sessionAllows.clear();
    if (planModeEnabled) {
      toolsBeforePlan ??= previousToolsBeforePlan ?? pi.getActiveTools();
      enablePlanTools();
      await applyPlanModeConfig(ctx);
    } else {
      if (previousToolsBeforePlan) pi.setActiveTools(previousToolsBeforePlan);
      toolsBeforePlan = undefined;
      if (wasPlan) {
        prePlanModel = preModel;
        prePlanThinking = preThinking;
        await restorePrePlan(ctx);
      }
    }
    updateStatus(ctx);
    persistState();
  });

  pi.on("model_select", async (event, ctx) => {
    if (applyingStoredModel || event.source === "restore") return;
    setPlanRegistry(ctx.modelRegistry);
    updateStatus(ctx);
  });

  /** Tool gating in plan mode:
   *    blocked mutators → hard error; bash writers → hard-block; bash reads →
   *    auto-allow; unknown executables + non-read tools → confirm tier. */
  pi.on("tool_call", async (event, ctx) => {
    if (!planModeEnabled) return;
    if (BLOCKED_TOOLS.has(event.toolName)) {
      return { block: true, reason: `plan mode: ${event.toolName} is not available while planning. Use ${PLAN_TOOL} to write the plan file.` };
    }
    if (event.toolName === ASK_USER_QUESTION_TOOL || event.toolName === PLAN_TOOL) return;

    if (isToolCallEventType("bash", event)) {
      const command = String(event.input.command || "");
      const disposition = classifyCommand(command);
      if (disposition === "read") return;
      if (disposition === "write") {
        return {
          block: true,
          reason: `plan mode: writing to the filesystem is not allowed while planning. "${command}" may modify files. Exit plan mode to run this command, or use ${PLAN_TOOL} to add file content to the plan.`,
        };
      }
      // planGate (classifier.planGate, off by default): may AUTO-RUN a safe
      // confirm-tier command. Any other answer → the confirm tier below,
      // unchanged. Never reached for read (already auto) or write (hard block).
      if (await planGateAutoRun(command, ctx)) return;
      if (!ctx.hasUI) return { block: true, reason: `plan mode: this command requires confirmation but UI is not available.\nCommand: ${command}` };
      const firstToken = command.trim().split(/\s+/)[0] || "bash";
      const allowKey = INTERPRETER_TOKENS.has(firstToken) ? `bash-cmd:${command.trim()}` : `bash:${firstToken}`;
      if (sessionAllows.has(allowKey)) return;
      const rememberNote = INTERPRETER_TOKENS.has(firstToken)
        ? '"Allow for this session" remembers only this exact command until plan mode toggles.'
        : `"Allow for this session" remembers \`${clip(firstToken)}\` commands until plan mode toggles.`;
      const reason = await planApprovalPrompt(
        ctx,
        "Allow command with possible side effects in plan mode?",
        `This command may execute repository-controlled code or modify files.\n\nCommand: ${clip(command)}\n\n${rememberNote}`,
        allowKey,
      );
      if (reason) return { block: true, reason: `plan mode: bash command ${reason}\nCommand: ${command}` };
      return;
    }

    // Subagent delegation is auto-allowed only when every named agent is read-only.
    if (event.toolName === "subagent") {
      const names = extractSubagentNames(event.input);
      // .pi/agents (project) + ~/.pi/agent/agents (user): the approval scope is "both".
      if (names.length > 0 && subagentsReadOnly(names, ctx.cwd)) return;
    }

    if (!READ_ONLY_TOOLS.has(event.toolName)) {
      if (!ctx.hasUI) return { block: true, reason: `plan mode: ${event.toolName} requires confirmation but UI is not available.` };
      const key = event.toolName === "subagent"
        ? `subagent:${[...extractSubagentNames(event.input)].sort().join(",")}`
        : event.toolName;
      if (sessionAllows.has(key)) return;
      const reason = await planApprovalPrompt(ctx, `Allow ${event.toolName} in plan mode?`, `Tool: ${event.toolName}`, key);
      if (reason) return { block: true, reason: `plan mode: ${reason}` };
      return;
    }
  });

  /** Inject the planning contract via systemPrompt chaining (composes with
   *  ponytail/advisor/subagent; steering stays the last prompt rewriter). */
  pi.on("before_agent_start", (event, ctx) => {
    if (!planModeEnabled) return;
    refreshSettings(ctx);
    const base = typeof event?.systemPrompt === "string" ? event.systemPrompt : "";
    const relativePlan = lastPlanPath
      ? relativeToCwd(ctx.cwd, lastPlanPath)
      : `${expandPlansDir(settings.plansDir)}/<timestamp>-<title>.md`;
    return {
      systemPrompt: base + buildPlanModePrompt({
        plansDir: expandPlansDir(settings.plansDir),
        relativePlan,
        deferredSave: settings.savePlans === "approved",
        noSave: settings.savePlans === "none",
        autoApprove: settings.autoApprove,
      }),
    };
  });

  /** Plan written → prefill /plan-approve, or execute immediately under
   *  auto-approve. */
  pi.on("agent_settled", async (event, ctx) => {
    if (!planModeEnabled || !planReadyForReview) return;
    // pi 1.1.0 flags runs the user cancelled (Escape): never approve off a
    // settle they aborted. Leave planReadyForReview set — a later clean
    // settle still picks the plan up.
    if ((event as { aborted?: boolean }).aborted) return;
    planReadyForReview = false;
    persistState();
    if (settings.autoApprove && ctx.mode !== "print") {
      ctx.ui.notify("Autonomous approval: plan approved, executing.", "info");
      await executeInCurrentSession(ctx);
      return;
    }
    if (!ctx.hasUI) return;
    ctx.ui.setEditorText("/plan-approve");
    ctx.ui.notify("Plan ready for approval. Press Enter to run /plan-approve.", "info");
  });

  // ── /config bridge ──────────────────────────────────────────

  const bridge: PlanBridge = {
    read: () => readPlanSettings({ cwd: liveCwd, isProjectTrusted: () => liveTrusted }),
    apply: (next) => { settings = next; },
  };
  setPlanBridge(bridge);
}

// Config contribution factory (registry wires it).
export { planConfig };
