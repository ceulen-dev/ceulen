// ponytail: vendored from @bacnh85/pi-advisor 0.3.8 (extensions/lib/isolated-model.ts), reworked
// to stream through the PUBLIC registry (`ctx.modelRegistry.streamSimple`) instead of pi-ai's
// compat entry point: the registry path resolves request-time auth and runs pi's own
// `prepareRequest` (provider + transformHeaders wiring), and it keeps the bundle free of an
// `@earendil-works/pi-ai` import that would need a peer dependency.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseModel, splitThinkingSuffix } from "./config.js";

export interface IsolatedContext {
  systemPrompt: string;
  messages: any[];
}

/** Token/cost accounting from the serving call (pi-ai `Usage`; cost in USD). */
export interface IsolatedUsage {
  input: number;
  output: number;
  cacheRead: number;
  totalTokens: number;
  cost: number;
}

/** OpenCode routes and caches per session; Console Go rejects requests without
 *  the header. pi's main loop attaches it inside the session's own
 *  `transformHeaders` closure, which an extension cannot reach — so isolated
 *  calls pass it as a request header (pi merges caller headers over the
 *  provider defaults on the registry path). */
export function opencodeSessionHeaders(
  model: { provider?: string; baseUrl?: string },
  sessionId: string | undefined,
): Record<string, string> | undefined {
  if (!sessionId) return undefined;
  let host = "";
  try { host = new URL(model.baseUrl ?? "").hostname; } catch { /* non-URL baseUrl: provider check decides */ }
  const isOpenCode = model.provider === "opencode" || model.provider === "opencode-go" || host === "opencode.ai";
  return isOpenCode ? { "x-opencode-session": sessionId, "x-opencode-client": "pi" } : undefined;
}

export function text(message: { content: Array<{ type: string; text?: string }> }): string {
  return message.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("");
}

export async function runIsolated(
  ctx: ExtensionContext,
  modelId: string | undefined,
  context: IsolatedContext,
  onDelta?: (delta: string) => void,
  signal?: AbortSignal,
  reasoning?: string,
  /** Progress hook — every stream event (incl. non-text deltas) resets the caller's idle deadline. */
  onEvent?: () => void,
): Promise<{ text: string; usage: IsolatedUsage }> {
  // A trailing `:level` on the chain entry pins thinking for this candidate;
  // `:off` and no suffix fall back to the chain-wide reasoning (or the
  // provider default when that is unset too).
  const { name, thinking } = modelId ? splitThinkingSuffix(modelId) : { name: modelId, thinking: undefined };
  const effectiveReasoning = thinking && thinking !== "off" ? thinking : reasoning;
  const parsed = name ? parseModel(name) : undefined;
  if (modelId && !parsed) throw new Error(`Invalid model: ${modelId}`);
  const model = parsed ? ctx.modelRegistry.find(parsed.provider, parsed.id) : ctx.model;
  if (!model) throw new Error(`Model unavailable: ${modelId ?? "active"}`);
  // Auth, credentials and provider wiring are resolved by the registry at
  // request time — this call site never touches a key.
  const headers = opencodeSessionHeaders(model, ctx.sessionManager?.getSessionId?.());
  const streamOptions = {
    signal,
    ...(effectiveReasoning ? { reasoning: effectiveReasoning } : {}),
    ...(headers ? { headers } : {}),
  } as never;
  // ponytail: landscape-evidence is a raw {systemPrompt, messages} object; the
  // registry normalizes it internally (same shape pi's own callers pass).
  const response = ctx.modelRegistry.streamSimple(model, context as never, streamOptions);
  for await (const event of response) {
    onEvent?.();
    if (event.type === "text_delta") onDelta?.(event.delta);
  }
  const result = await response.result();
  if (result.stopReason !== "stop") throw new Error(result.errorMessage ?? `Model stopped: ${result.stopReason}`);
  const u = (result as { usage?: { input?: number; output?: number; cacheRead?: number; totalTokens?: number; cost?: { total?: number } } }).usage;
  const usage: IsolatedUsage = {
    input: u?.input ?? 0,
    output: u?.output ?? 0,
    cacheRead: u?.cacheRead ?? 0,
    totalTokens: u?.totalTokens ?? 0,
    cost: u?.cost?.total ?? 0,
  };
  return { text: text(result), usage };
}

/** Idle deadline per candidate: a candidate is aborted only after timeoutMs
 *  with NO stream events — healthy slow streams (reasoning models, large
 *  transcripts) keep resetting it, so progress is never killed. Caller abort
 *  propagates immediately. streamSimple honors the signal (same mechanism as
 *  tool-call abort). */
const CANDIDATE_TIMEOUT_MS = 90_000;

function idleSignal(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; touch(): void; dispose(): void } {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), timeoutMs);
  };
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  arm();
  return {
    signal: controller.signal,
    touch: arm,
    dispose() {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * Try each model in priority order: unresolvable candidates are skipped;
 * any call error (rate limit, quota, unavailable, network, timeout) advances
 * to the next candidate — for a best-effort reviewer any dead candidate should
 * yield to the next. All exhausted → the last error is rethrown.
 * No parent-model fallback: the advisor must never use the primary model.
 */
/** Delta sink; `attempt` increments each time a new candidate starts, so
 *  callers can reset progressive state when a dead candidate is replaced. */
export type ChainOnDelta = (delta: string, attempt: number) => void;

export interface ChainResult {
  text: string;
  model: string;
  usage: IsolatedUsage;
}

export async function runIsolatedChain(
  ctx: ExtensionContext,
  models: readonly string[],
  context: IsolatedContext,
  onDelta?: ChainOnDelta,
  signal?: AbortSignal,
  reasoning?: string,
  // ponytail: test seam — production callers use the 90s default
  timeoutMs: number = CANDIDATE_TIMEOUT_MS,
): Promise<ChainResult> {
  let lastError: unknown;
  for (const [attempt, modelId] of models.entries()) {
    if (signal?.aborted) throw new Error("Advisor call aborted");
    const idle = idleSignal(signal, timeoutMs);
    try {
      const { text, usage } = await runIsolated(ctx, modelId, context, (delta) => onDelta?.(delta, attempt), idle.signal, reasoning, idle.touch);
      return { text, usage, model: modelId };
    } catch (error) {
      // An abort is a caller decision, not a dead model — do not fall through.
      if (signal?.aborted) throw error;
      lastError = error;
    } finally {
      idle.dispose();
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`All advisor models failed: ${models.join(", ") || "none configured"}`);
}
