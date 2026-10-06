// The judge adapter: OMP's `Judge` seam implemented over pi's public
// modelRegistry.classify (the classifier module's askJev pattern: settings
// override → first available classifier model on the router provider, one
// cold-start forced refresh). Fails LOUD when no classifier model resolves —
// the caller surfaces the remediation hint.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Request, JudgmentResult, Judge } from "./questions.js";

const COOLDOWN_MS = 60_000;
let lastForcedRefresh = 0;

/** Test hook: clear the cold-start cooldown (module state outlives a test). */
export function resetJudgeCooldown(): void {
  lastForcedRefresh = 0;
}

interface ClassifyAnswer {
  probability?: number;
  noul?: number;
}

/**
 * Resolve the classifier model once per call and return a Judge whose
 * `judge()` routes through modelRegistry.classify. Throws when the registry
 * is missing or no classifier model is configured — jfind's execute turns
 * that into the tool's remediation error.
 */
export function createJudge(ctx: ExtensionContext): Judge {
  const registry = ctx?.modelRegistry;
  if (!registry) throw new Error("jfind has no model registry to resolve a judge from");

  const resolve = async () => {
    const available = await registry.getAvailableOfType("classifier", "router");
    return available[0];
  };
  return {
    label: "classifier/system-one",
    async judge(request: Request, options?: { signal?: AbortSignal }): Promise<JudgmentResult> {
      let model = await resolve();
      if (!model && Date.now() - lastForcedRefresh > COOLDOWN_MS) {
        // Cold start: the router catalog's network pull races session start.
        lastForcedRefresh = Date.now();
        try {
          await registry.refresh({ providers: ["router"], force: true });
        } catch {
          /* offline — the remediation error below still fires */
        }
        model = await resolve();
      }
      if (!model) {
        throw new Error(
          "no classifier model available — configure the router provider (router.baseUrl + /login router) so a System One model is in the catalog, or disable jfind",
        );
      }
      const result = await registry.classify(
        model,
        { state: request.state as never, questions: request.questions as never },
        { signal: options?.signal as never },
      );
      if (result.stopReason !== "stop") throw new Error(result.errorMessage ?? `classifier failed (${result.stopReason})`);
      const answers: Record<string, { probability?: number }> = {};
      for (const [key, value] of Object.entries(result.answers ?? {})) {
        const a = value as ClassifyAnswer | undefined;
        const p = a && typeof a === "object" ? a.probability ?? a.noul : undefined;
        answers[key] = { probability: typeof p === "number" && Number.isFinite(p) ? p : undefined };
      }
      return {
        answers,
        usage: result.usage ? { input: result.usage.input, output: result.usage.output } : undefined,
      };
    },
  };
}
