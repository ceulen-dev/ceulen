// ponytail: vendored from @earendil-works/pi-ai 0.99.1
// (api/typesafe-system-one.js + api/system-one-shared.js), slimmed:
// direct fetch + single attempt (pi-classifier's proven shape against
// yardmaster), no onPayload/onResponse hooks, no error-envelope utils.
// Re-check upstream system-one-shared.js on peer-range bumps.
//
// Types are DERIVED from the public ProviderConfig surface (pi root does not
// re-export ClassifierModel/Context/Result) — same trick as provider.ts's
// RefreshCtx.

import type { ProviderConfig } from "@earendil-works/pi-coding-agent";

type ClassifierImpl = NonNullable<NonNullable<ProviderConfig["classifiers"]>["typesafe-system-one"]>;
type ClassifyFn = ClassifierImpl["classify"];
export type ClassifierModelT = Parameters<ClassifyFn>[0];
export type ClassifierContextT = Parameters<ClassifyFn>[1];
export type ClassifierOptionsT = Parameters<ClassifyFn>[2];
export type ClassifierResultT = Awaited<ReturnType<ClassifyFn>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function url(model: ClassifierModelT): string {
  return `${model.baseUrl.replace(/\/+$/u, "")}/systemone`;
}

function requiredNumber(label: string, value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} returned an invalid ${field}`);
  }
  return value;
}

function probabilities(label: string, value: unknown, id: string): Record<string, number> {
  if (!isRecord(value)) throw new Error(`${label} returned invalid probabilities for ${id}`);
  return Object.fromEntries(
    Object.entries(value).map(([key, probability]) => [key, requiredNumber(label, probability, `probability for ${id}.${key}`)]),
  );
}

/** Wire answers → public answers. Public `bool` answers arrive as `noul`. */
function parseAnswers(label: string, value: unknown, context: ClassifierContextT): ClassifierResultT["answers"] {
  if (!isRecord(value)) throw new Error(`${label} returned an unexpected response`);
  const answers: [string, unknown][] = [];
  for (const [id, question] of Object.entries(context.questions)) {
    const answer = value[id];
    if (!isRecord(answer)) throw new Error(`${label} did not return an answer for ${id}`);
    if (question.type === "choice") {
      if (answer.type !== "choice" || typeof answer.choice !== "string") {
        throw new Error(`${label} did not return a choice answer for ${id}`);
      }
      answers.push([id, {
        type: "choice",
        choice: answer.choice,
        probabilities: probabilities(label, answer.probabilities, id),
        confidence: requiredNumber(label, answer.confidence, `confidence for ${id}`),
      }]);
    } else if (question.type === "score") {
      if (answer.type !== "score") throw new Error(`${label} did not return a score answer for ${id}`);
      answers.push([id, {
        type: "score",
        score: requiredNumber(label, answer.score, `score for ${id}`),
        confidence: requiredNumber(label, answer.confidence, `confidence for ${id}`),
      }]);
    } else {
      if (answer.type !== "noul") throw new Error(`${label} did not return a bool answer for ${id}`);
      answers.push([id, { type: "bool", probability: requiredNumber(label, answer.noul, `probability for ${id}`) }]);
    }
  }
  return Object.fromEntries(answers) as ClassifierResultT["answers"];
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Usage from `{ input_tokens, output_tokens }`, priced from the (zero) router
 *  catalog rates. Missing/malformed → no usage, never a failure. */
function parseUsage(value: unknown, model: ClassifierModelT): ClassifierResultT["usage"] {
  if (!isRecord(value) || (value.input_tokens === undefined && value.output_tokens === undefined)) return undefined;
  const input = tokenCount(value.input_tokens);
  const output = tokenCount(value.output_tokens);
  const rates = model.cost;
  const cost = {
    input: (rates.input / 1_000_000) * input,
    output: (rates.output / 1_000_000) * output,
    cacheRead: 0,
    cacheWrite: 0,
  };
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { ...cost, total: cost.input + cost.output },
  };
}

/** Public `bool` questions map to TypeSafe's wire-level `noul` type. */
function wireRequest(context: ClassifierContextT): { state: ClassifierContextT["state"]; questions: Record<string, unknown> } {
  return {
    state: context.state,
    questions: Object.fromEntries(
      Object.entries(context.questions).map(([id, question]) => [id, question.type === "bool" ? { ...question, type: "noul" } : question]),
    ),
  };
}

/** System One classification (TypeSafe wire) over the router endpoint.
 *  Never rejects — failures return `stopReason: "error"` per the ProviderClassifier contract. */
export const systemoneClassify: ClassifierImpl["classify"] = async (model, context, options) => {
  const output: ClassifierResultT = {
    api: model.api,
    provider: model.provider,
    model: model.id,
    answers: {},
    stopReason: "stop",
    timestamp: Date.now(),
  };
  try {
    if (model.api !== "typesafe-system-one") throw new Error(`Unsupported classifier API: ${model.api}`);
    if (!options?.apiKey) throw new Error(`No API key for provider: ${model.provider}`);
    const headers: Record<string, string> = {
      authorization: `Bearer ${options.apiKey}`,
      "content-type": "application/json",
      ...(options.headers ?? {}),
    };
    const timeoutSignal = options.timeoutMs !== undefined ? AbortSignal.timeout(options.timeoutMs) : undefined;
    const signal = options.signal && timeoutSignal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : (options.signal ?? timeoutSignal);
    const response = await fetch(url(model), {
      method: "POST",
      headers,
      body: JSON.stringify({ model: model.id, ...wireRequest(context) }),
      signal,
    });
    if (!response.ok) throw new Error(`System One API returned ${response.status}: ${(await response.text()).slice(0, 500)}`);
    const body: unknown = await response.json();
    if (!isRecord(body)) throw new Error("System One API returned an unexpected response");
    const usage = parseUsage(body.usage, model);
    if (usage) output.usage = usage;
    output.answers = parseAnswers("System One API", body.answers, context);
    return output;
  } catch (error) {
    output.stopReason = options?.signal?.aborted ? "aborted" : "error";
    output.errorMessage = error instanceof Error ? error.message : String(error);
    return output;
  }
};
