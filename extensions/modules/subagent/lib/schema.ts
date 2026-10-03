// ponytail: inlined from @earendil-works/pi-ai utils/typebox-helpers (StringEnum)
// — the bundle never imports pi-ai at runtime (single-peer contract); this is
// the only runtime value index.ts took from it.

import { type TUnsafe, Type } from "typebox";

/**
 * Creates a string enum schema compatible with Google's API and other providers
 * that don't support anyOf/const patterns.
 */
export function StringEnum<T extends readonly string[]>(values: T, options?: {
  description?: string;
  default?: T[number];
}): TUnsafe<T[number]> {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: values as unknown as string[],
    ...(options?.description ? { description: options.description } : {}),
    ...(options?.default !== undefined ? { default: options.default } : {}),
  });
}
