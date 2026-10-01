// Shared ux instruction builder (ceulen ux module).
// ponytail: vendored from @bacnh85/pi-ux 0.6.6 (hooks/ux-instructions.js).
//
// Reads the skill body, strips frontmatter, prepends a mode banner.
// No per-mode row filtering needed here — the UX method is mode-invariant;
// only the banner differs (strict enforces the audit gate).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MODE, normalizeMode } from "./config.js";

const SKILL_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..", "..", // modules/ux/lib → extensions/modules → extensions → package root
  "skills", "ux-design", "SKILL.md",
);

// Memoized SKILL.md read: before_agent_start fires every turn, so one stat
// per call beats readFileSync+parse every time. Re-read only when
// path/mtime/size change (same pattern as ponytail-config's readConfig).
let skillCache: { path: string; mtimeMs: number; size: number; body: string | null } = {
  path: SKILL_PATH,
  mtimeMs: -1,
  size: -1,
  body: null,
};

function readSkillBody(): string {
  let mtimeMs = -1, size = -1;
  try {
    const st = fs.statSync(SKILL_PATH);
    mtimeMs = st.mtimeMs; size = st.size;
    if (
      skillCache.path === SKILL_PATH &&
      skillCache.mtimeMs === st.mtimeMs &&
      skillCache.size === st.size &&
      skillCache.body !== null
    ) {
      return skillCache.body;
    }
  } catch {
    // stat failed: fall through to the read's own error handling
  }
  const body = String(fs.readFileSync(SKILL_PATH, "utf8")).replace(/^---[\s\S]*?---\s*/, "");
  skillCache = { path: SKILL_PATH, mtimeMs, size, body };
  return body;
}

export function getUxInstructions(mode: unknown): string {
  const configuredMode = normalizeMode(mode) || DEFAULT_MODE;
  const effectiveMode = normalizeMode(configuredMode) || DEFAULT_MODE;

  const banner = effectiveMode === "strict"
    ? "UX DISCIPLINE ACTIVE — level: strict. Run ux_audit before declaring a screen done; block handoff on fail."
    : "UX DISCIPLINE ACTIVE — level: lite. Anti-slop guardrail enforced; audit gate recommended but not blocking.";

  try {
    return banner + "\n\n" + readSkillBody();
  } catch {
    // ponytail: SKILL.md missing or unreadable — compact inline fallback keeps the guardrail.
    return [
      banner,
      "",
      "You implement UI INSIDE an existing design system. You do NOT invent visual language.",
      "- Tokens ONLY (colour/type/spacing/radius/elevation). No off-system values.",
      "- Elevation: named levels only. Never invent shadow blur/opacity.",
      "- Accent: ONLY the defined accent token. No purple/indigo glow unless requested.",
      "- Type: modular scale only. No custom font sizes.",
      "- Spacing: 8px grid via tokens. No magic pixel values.",
      "- Every interactive element declares: default, hover, focus-visible, active, disabled",
      "  + error/empty/loading where relevant.",
      "- Before markup: output a 1-line inventory of components + states.",
      "- If ambiguous, ASK. Do not guess aesthetics.",
    ].join("\n");
  }
}
