// Repeat-tool-reminder — advisory loop guard for EXACT repeated tool calls.
//
// Ported from DeepSeek Harness `packages/guard/repeat-tool-reminder`. The pi
// seam differs from DSH's (`tools/post-execute` can attach additionalContexts
// there; pi's `tool_result` result can only patch content), so the advisory
// channel is a FOOTER appended to the result text: the call still executes and
// its real output survives — unlike ceulen's two blocking guards (permission's
// doom-loop on denied calls, munin's dampener on munin tools), which refuse.
//
// Counting is on post-execution for that reason: a model hammering a call that
// SUCCEEDS is the DeepSeek Flash loop failure mode, and a refusal would erase
// the evidence the model needs to change approach.

/** Consecutive-repeat counts that trigger a reminder (DSH default). */
export const REPEAT_THRESHOLDS = [3, 5, 8] as const;
/** Canonical arguments quoted in the detailed reminder (DSH cap). */
export const ARGUMENTS_PREVIEW_CHARS = 500;
/** The munin module's own dampener owns its tools — never double-advise. */
const MUNIN_PREFIX = "munin_";

/** Deep key-sort so two argument objects differing only in property order
 *  canonicalize identically (DSH sortJsonValue; arguments arrive as the loop's
 *  JSON.parse output, so JSON's value domain is the whole input domain). */
export function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) sorted[key] = sortJsonValue(record[key]);
    return sorted;
  }
  return value;
}

/** Canonical string form of a call's arguments: deep key-sort, then stringify. */
export function canonicalizeArguments(args: unknown): string {
  return JSON.stringify(sortJsonValue(args));
}

/** Identity key of one call: tool name + canonical arguments. */
export function callKey(toolName: string, args: unknown): string {
  return JSON.stringify([toolName, canonicalizeArguments(args)]);
}

/** Whether a tool participates in the chain (munin tools are excluded). */
export function isTrackedTool(toolName: string): boolean {
  return !toolName.startsWith(MUNIN_PREFIX);
}

const GENTLE_REMINDER =
  "Same tool call repeated with identical arguments — analyze the previous result "
  + "before calling again: if the task is not complete, try a different approach or "
  + "different arguments instead of repeating the call.";

function previewArguments(canonical: string): string {
  if (canonical.length <= ARGUMENTS_PREVIEW_CHARS) return canonical;
  return `${canonical.slice(0, ARGUMENTS_PREVIEW_CHARS)}… (+${canonical.length - ARGUMENTS_PREVIEW_CHARS} more chars)`;
}

/** The reminder text for a chain that just hit `count`, or undefined. */
export function reminderFor(toolName: string, count: number, canonical: string): string | undefined {
  if (!(REPEAT_THRESHOLDS as readonly number[]).includes(count)) return undefined;
  const body = count === REPEAT_THRESHOLDS[0]
    ? GENTLE_REMINDER
    : `Repeated tool call detected:\n- tool: ${toolName}\n- consecutive_calls: ${count}\n- arguments: ${previewArguments(canonical)}\nThe repeated calls are not making progress. Do not call this tool with these exact arguments again — inspect the latest result and choose a different action, different arguments, or finish the task.`;
  return `\n\n[ceulen] ${body}`;
}

/** One session's consecutive-repeat chain. */
export interface RepeatChain {
  key: string;
  count: number;
}

/**
 * Advance a chain for one call and return the footer to append, if any.
 * Untracked tools are TRANSPARENT (neither count nor reset), matching DSH.
 */
export function advanceChain(
  chain: RepeatChain | undefined,
  toolName: string,
  args: unknown,
): { chain: RepeatChain; footer?: string } | undefined {
  if (!isTrackedTool(toolName)) return undefined;
  const key = callKey(toolName, args);
  const count = chain !== undefined && chain.key === key ? chain.count + 1 : 1;
  const next: RepeatChain = { key, count };
  const footer = reminderFor(toolName, count, canonicalizeArguments(args));
  return footer === undefined ? { chain: next } : { chain: next, footer };
}
