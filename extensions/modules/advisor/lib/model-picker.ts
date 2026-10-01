// ponytail: vendored from @bacnh85/pi-advisor 0.3.8 (extensions/lib/model-picker.ts), minus
// `chooseModel`: the /config Model → Advisor menu is the picker now, so the
// ModelSelectorComponent adapter (and its hand-built runtime shim) is gone.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { splitThinkingSuffix } from "./config.js";

export type Model = ReturnType<ExtensionContext["modelRegistry"]["getAvailable"]>[number];

export function modelRef(model: Pick<Model, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

/** Resolve a `provider/model` (or unambiguous bare id) reference against available models.
 *  A trailing `:level` thinking suffix is ignored for matching. */
export function exactModel(models: Model[], reference: string): Model | undefined {
  const { name } = splitThinkingSuffix(reference.trim());
  const value = name.toLowerCase();
  if (!value) return undefined;
  const canonical = models.filter((model) => modelRef(model).toLowerCase() === value);
  if (canonical.length === 1) return canonical[0];
  if (canonical.length > 1) return undefined;
  const ids = models.filter((model) => model.id.toLowerCase() === value);
  return ids.length === 1 ? ids[0] : undefined;
}

export function modelAvailable(ctx: ExtensionContext, modelId: string | undefined): boolean {
  return !!modelId && !!exactModel(ctx.modelRegistry.getAvailable(), modelId);
}

/** Canonicalize a chain entry: resolve the ref (ignoring a trailing `:level`),
 *  re-attach the level so a pinned thinking level survives the save. */
export function canonicalEntry(models: Model[], entry: string): string {
  const { name, thinking } = splitThinkingSuffix(entry.trim());
  const match = exactModel(models, name);
  if (!match) return entry;
  return thinking ? `${modelRef(match)}:${thinking}` : modelRef(match);
}

/** First registry-available ref in the chain, or undefined when none resolve. */
export function firstAvailable(ctx: ExtensionContext, models: readonly string[]): string | undefined {
  return models.find((model) => modelAvailable(ctx, model));
}

export function modelSearchText(model: Model): string {
  const ref = modelRef(model);
  return `${model.id} ${model.provider} ${ref} ${model.provider} ${model.id}${model.name ? ` ${model.name}` : ""}`;
}
