// Spill store — where an oversized tool result's full text is written.
//
// Adapted from DeepSeek Harness `packages/spill/spill-local/src/store.ts`.
// One private temp root per process (DSH's `privateRoot`), one file per spill.
// `encodeSegment` is DSH's injective escaping: tool names and call ids are not
// trusted (`../../etc/passwd`, NUL, separators), so each is encoded to a single
// safe path segment rather than sanitised by deletion (which could collide).

import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Prefix of the private per-process root. */
export const DEFAULT_ROOT_PREFIX = "ceulen-spill-";

let defaultRoot: string | undefined;
/** Monotonic counter making every spill file unique (see saveSpill). */
let spillSeq = 0;

/** The lazily-created private per-process spill root. */
export function privateRoot(): string {
  defaultRoot ??= mkdtempSync(join(tmpdir(), DEFAULT_ROOT_PREFIX));
  return defaultRoot;
}

/** Test seam: override the root (a path that cannot be created exercises the
 *  fail-open path). Passing undefined returns to the lazy temp root. */
export function setSpillRootForTests(root: string | undefined): void {
  defaultRoot = root;
}

const SAFE = /[A-Za-z0-9._-]/;

/**
 * Encode arbitrary text as ONE filesystem-safe path segment, injectively.
 * Each code unit is kept literal when safe (except `~`) or escaped as `~XXXX`;
 * `~` is itself escaped, so distinct inputs never collide. The whole-segment
 * tokens `.` and `..` are escaped so they can never traverse.
 */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) return "~";
  if (raw === ".") return "~002E";
  if (raw === "..") return "~002E~002E";
  let out = "";
  for (const unit of raw) {
    const code = unit.codePointAt(0) ?? 0;
    if (code > 0xffff) {
      // Non-BMP: encode both surrogate halves so the mapping stays injective.
      for (let i = 0; i < unit.length; i++) out += `~${unit.charCodeAt(i).toString(16).toUpperCase().padStart(4, "0")}`;
      continue;
    }
    out += unit !== "~" && SAFE.test(unit) ? unit : `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return out;
}

/**
 * Write the full text of one tool result and return its absolute path.
 * Creates the root on first use (a missing parent would otherwise make the
 * write fail and spill would skip silently every time).
 */
export async function saveSpill(toolName: string, callId: string, text: string): Promise<string> {
  const root = privateRoot();
  await mkdir(root, { recursive: true });
  // Monotonic suffix: a retried call reusing a toolCallId must never overwrite
  // a spill an older transcript entry still points at — each spill is
  // immutable once the model has been told its path.
  const file = join(root, `${encodeSegment(toolName)}-${encodeSegment(callId)}-${++spillSeq}.txt`);
  await writeFile(file, text, { encoding: "utf8", mode: 0o600 });
  return file;
}
