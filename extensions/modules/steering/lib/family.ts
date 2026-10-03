/**
 * family.ts — detect which model family is active.
 *
 * Two families: "deepseek-v4" and "glm". Provider-agnostic.
 * Add a third family when a third family exists — no premature abstraction.
 */
// ponytail: vendored from @bacnh85/pi-model-tools 0.9.5
// (extensions/lib/model-detection.ts). Local change: the env-knob helpers are
// dropped — repairEnabled/blockDangerousEnabled belong to the repair and
// dangerous-command modules, maxErrorHistory is a constant here, and
// reasoningStripEnabled/autoBlockAfterReminders map to the `steering`
// settings rows in lib/settings.ts.

export type ModelFamily = "deepseek-v4" | "glm";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Detect the model family from a model ref.
 * Returns null for unrecognized models (no steering applied).
 */
export function detectFamily(model?: { provider?: string; id?: string }): ModelFamily | null {
  const id = (model?.id ?? "").toLowerCase();
  if (!id) return null;
  // ponytail: provider-agnostic substring + word-boundary — robust across id formats
  // `-flash\b` covers the V4.1 Flash canonical id `deepseek-flash` (incl. prefixed
  // variants like `ds/deepseek-flash`); `\bv4\b` covers deepseek-v4* incl. v4.1.
  if (id.includes("deepseek") && (/\bv4\b/.test(id) || /-flash\b/.test(id))) return "deepseek-v4";
  if (id.includes("glm")) return "glm";
  return null;
}
