// ponytail: vendored from @bacnh85/pi-model-tools 0.9.5 — lib/shell-helpers.ts
// PORTED SUBSET (deliberate): only the two TOOL-HARDENING guards —
// checkDangerousCommand + looksLikeCodePath — and their private deps
// (normalizedTarget, isRecord). The semantic-miss / dedicated-tool /
// error-categorization half of the upstream file belongs to the model-steering
// layer and is NOT ported here. isRecord is duplicated into this module rather
// than imported across modules (ceulen modules never reach into each other).

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedTarget(value: unknown): string {
  return (typeof value === "string" ? value.toLowerCase() : "").split(/[?#]/, 1)[0];
}

/** True when the value looks like an indexable source file (extension match). */
export function looksLikeCodePath(value: unknown): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|py|go|rs|java|kt|kts|scala|rb|php|cs|cpp|cc|cxx|c|h|hpp|swift|sh|bash|zsh|fish|lua|r|jl|ex|exs|erl|hrl|clj|cljs|fs|fsx|ml|mli|dart|vue|svelte)$/i.test(normalizedTarget(value));
}

/** Returns a human reason when a bash command is destructively dangerous. */
export function checkDangerousCommand(command: unknown): string | undefined {
  if (typeof command !== "string") return undefined;
  const trimmed = command.trim().toLowerCase();
  for (const [, args] of trimmed.matchAll(/\brm\s+([^;&|\n]+)/g)) {
    const recursive = /(?:^|\s)(?:-[a-z]*r[a-z]*|--recursive)(?:\s|$)/.test(args);
    const forced = /(?:^|\s)(?:-[a-z]*f[a-z]*|--force)(?:\s|$)/.test(args);
    const absolute = /(?:^|\s)(?:--\s+)?(?:["']\/[^"']*["']|\/\S*)(?:\s|$)/.test(args);
    if (recursive && forced && absolute) return "Forced recursive delete of an absolute path";
  }
  if (/\bdd\b[^\n;&|]*\bof=["']?\/dev\/(?:sd[a-z]\d*|vd[a-z]\d*|xvd[a-z]\d*|nvme\d+n\d+(?:p\d+)?|mmcblk\d+(?:p\d+)?|disk\d+|rdisk\d+|loop\d+|md\d+|mapper\/[a-z0-9._+-]+)\b/.test(trimmed)) return "Destructive dd write to a block device";
  return undefined;
}
