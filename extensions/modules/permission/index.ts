/**
 * permission — granular, persistent allow/ask/deny rules per tool.
 *
 * Ported from @bacnh85/pi-permission 0.2.10 (plain JS → TS; zero behavior
 * deltas except the plan-mode deferral below). An opt-in companion to Pi's
 * container-first philosophy: config-driven rules in the `permission` section
 * of .pi/settings.json (trust-gated project) or the agent-dir settings.json —
 * the first file carrying the section wins. No rules configured → the module
 * has NO opinion (inert).
 *
 * Actions: "allow" (silent), "ask" (prompt via ctx.ui), "deny" (block).
 * Patterns: `*` (zero+ chars), `?` (one char), else literal. Last match wins.
 * external_directory is a deny-only boundary gate for path tools.
 * Flags: --yolo / --auto auto-approve "ask" (explicit deny still enforced).
 * Doom-loop guard: the 3rd identical consecutive call is blocked.
 *
 * ceulen delta: while plan mode is active the handler returns undefined (no
 * opinion) — plan mode owns tool gating then; without this, both hooks
 * prompt on the same call. See extensions/lib/plan-bridge.ts.
 */

import { readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import * as nodePath from "node:path";
import os from "node:os";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { isPlanActive } from "../../lib/plan-bridge.ts";

/** A rule object: pattern → action. Whole-tool string rules are kept too. */
type RuleMap = Record<string, string>;
/** The `permission` settings section: tool name → rules (or whole-tool verb).
 *  `external_directory` is deny-only and always a rule object (validated at
 *  runtime by warnInvalidRules). */
export interface PermissionRules {
  [tool: string]: string | RuleMap;
}
/** The narrowed external_directory entry. */
export type ExternalDirectoryRules = RuleMap;

const ACTIONS = new Set(["allow", "ask", "deny"]);

/**
 * Convert an OpenCode-style wildcard pattern to a RegExp.
 * `*` → zero+ chars, `?` → exactly one char, everything else literal.
 * Patterns match against the WHOLE subject string (anchored).
 * Exported for unit testing.
 */
export function wildcardToRegex(pattern: string): RegExp {
  // Escape regex specials, collapse runs of `*` (OpenCode: `*` matches zero or
  // more of ANY char including `/`, so `**` == `*`), convert `?` to any-one.
  let re = "";
  let prevStar = false;
  for (const ch of String(pattern)) {
    if (ch === "*") {
      if (prevStar) continue; // collapse **, ***, ... → single .*
      re += ".*";
      prevStar = true;
      continue;
    }
    prevStar = false;
    if (ch === "?") re += ".";
    else if ("\\^$.|+()[]{}:".includes(ch)) re += "\\" + ch;
    else re += ch;
  }
  // "s" flag: `*` must cross newlines like it crosses `/` — without it,
  // multiline commands (heredocs, multi-line scripts) matched NO rule and
  // bypassed every ask/deny.
  return new RegExp("^" + re + "$", "s");
}

/**
 * Resolve a single rule object { pattern: action } to an action for a subject.
 * Rules evaluated in insertion order, LAST matching rule wins (OpenCode semantics).
 * Returns the action or null (no rule matched).
 * If `home` is provided, `~` and `$HOME` are expanded in BOTH pattern and subject
 * so a pattern like `~/projects/**` matches an absolute path like `/home/u/...`.
 * Exported for unit testing.
 */
export function resolveRule(rules: RuleMap, subject: string, home?: string): string | null {
  if (!rules || typeof rules !== "object") return null;
  let action: string | null = null;
  const subj = home ? expandHome(subject, home) : subject;
  for (const [pattern, val] of Object.entries(rules)) {
    const pat = home ? expandHome(pattern, home) : pattern;
    if (wildcardToRegex(pat).test(subj)) action = val;
  }
  return action;
}

/**
 * Expand leading ~ or $HOME in a path pattern. An empty home returns the
 * pattern unchanged — expanding would turn `~/x` into `/x` via join.
 * Exported for unit testing.
 */
export function expandHome(pattern: string, home?: string): string {
  if (!home) return pattern;
  if (pattern === "~") return home;
  if (pattern.startsWith("~/")) return nodePath.join(home, pattern.slice(2));
  if (pattern.startsWith("$HOME/")) return nodePath.join(home, pattern.slice(6));
  return pattern;
}

/** Read one settings.json key directly from disk: cwd/.pi (when `project`) →
 *  PI_CODING_AGENT_DIR|~/.pi/agent → ~/.pi/agents, first file containing the
 *  key wins. The project scope is gated on `project`: settings.json inside an
 *  untrusted checkout must not disable the user's ask/deny guardrails. Only
 *  plain objects count; wrong shapes warn and fall through to the next scope.
 *  Exported for unit testing. */
export function readSettingsKey(cwd: string | undefined, key: string, { project = true } = {}): Record<string, unknown> | undefined {
  const home = os.homedir();
  const dirs = [
    ...(project ? [nodePath.join(cwd || process.cwd(), ".pi")] : []),
    process.env.PI_CODING_AGENT_DIR || nodePath.join(home, ".pi", "agent"),
    nodePath.join(home, ".pi", "agents"),
  ];
  for (const dir of dirs) {
    try {
      const parsed = JSON.parse(readFileSync(nodePath.join(dir, "settings.json"), "utf8")) as Record<string, unknown>;
      const v = parsed?.[key];
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
      if (v !== undefined) {
        // Parsed but wrong shape: warn and CONTINUE to the next settings location,
        // so a bad project-level key can't shadow a valid global one.
        console.warn(
          `${key}: ${nodePath.join(dir, "settings.json")} has a non-object "${key}" value — ignoring (trying next settings location)`,
        );
      }
    } catch {
      // missing/unreadable settings.json is fine — try next location
    }
  }
  return undefined;
}

/**
 * Normalize a tool's "subject" — the string patterns are matched against.
 * bash → the command; read/write/edit/grep/find/ls → the raw path as the
 * model passed it (patterns are written relative, e.g. `src/*.ts`, so we do
 * NOT resolve to absolute here — external_directory handles absolute matching
 * separately).
 */
function toolSubject(toolName: string, input: Record<string, unknown> | undefined): string {
  if (toolName === "bash") return String(input?.command || "");
  if (["grep", "find", "ls", "read", "write", "edit"].includes(toolName)) {
    return String(input?.path || "");
  }
  return "";
}

/**
 * Normalized match subjects for path tools. Rules are matched against the
 * traversal-normalized relative form AND the absolute form — never the raw
 * string: raw matching let `src/../../x` satisfy `src/*` (`*` crosses `/`,
 * `..` was never resolved) and let absolute `/proj/private/k` slip past a
 * relative `private/*` deny. Falls back to the raw string if resolution
 * throws (exotic inputs must not crash the gate).
 */
export function normalizedSubjects(
  raw: string | undefined,
  cwd: string | undefined,
  home?: string,
  ppath?: typeof nodePath.posix | typeof nodePath.win32,
): { rel: string; abs: string } {
  const s = String(raw || "");
  if (!s.trim()) return { rel: "", abs: "" }; // subject-less call stays subject-less
  try {
    // Drive-letter input/cwd (C:\… or C:/…) resolves under path.win32 even on
    // a posix host — WSL-boundary rules and cross-platform configs stay sane.
    const P = ppath || (/^[A-Za-z]:[/\\]/.test(s) || /^[A-Za-z]:[/\\]/.test(cwd || "") ? nodePath.win32 : nodePath);
    const root = P.resolve(cwd || process.cwd());
    const abs = P.resolve(root, expandHome(s, home));
    const rel = P.relative(root, abs) || ".";
    return { rel, abs };
  } catch {
    return { rel: s, abs: s };
  }
}

// Per-pattern subject selection: relative patterns match the normalized
// relative subject, absolute/~/patterns match the absolute form (keeps a
// scoped allow from being overridden by its own `*` fallback matching the
// other subject form). Insertion order + last-match-wins preserved.
function resolvePathAction(toolRules: RuleMap, rel: string, abs: string, home?: string): string | null {
  let action: string | null = null;
  for (const [pattern, val] of Object.entries(toolRules)) {
    const pat = home ? expandHome(pattern, home) : pattern;
    // Absolute = posix `/…` OR win32 drive-letter `C:\…`/`C:/…` (nodePath is
    // platform-correct in production; the drive-letter test covers rules
    // written for a Windows cwd from any host).
    const subject = pat.startsWith("/") || /^[A-Za-z]:[/\\]/.test(pat) ? abs : rel;
    if (wildcardToRegex(pat).test(subject)) action = val;
  }
  return action;
}

function resolve(p: string | undefined, cwd: string, ppath: typeof nodePath.posix | typeof nodePath.win32 = nodePath as unknown as typeof nodePath.posix): string {
  if (!p) return "";
  // node:path resolve normalizes `..` — the old hand-rolled join left it in
  // place ("../x" → "/proj/../x"), so the isExternal prefix check classified
  // traversal paths as internal and they bypassed the deny gate.
  return ppath.resolve(cwd || ppath.sep, p);
}

/**
 * Check whether `path` falls outside `cwd` (the external-directory boundary).
 * A path exactly equal to cwd (e.g. reading the project root itself) is NOT
 * external — only strictly-outside paths are.
 *
 * Containment uses path.relative, NOT a `root + "/"` prefix check: win32
 * pathResolve yields backslash separators, so the prefix check classified
 * every path as external and external_directory deny blocked all path tools
 * (upstream regression 0.2.5). Exported for unit testing; `ppath` lets tests
 * inject `path.win32` to exercise the exact code path production Windows takes.
 */
export function isExternal(path: string | undefined, cwd: string | undefined, ppath?: typeof nodePath.posix | typeof nodePath.win32): boolean {
  if (!path || !cwd) return false;
  const P = ppath || (nodePath as unknown as typeof nodePath.posix);
  const abs = resolve(path, cwd, P);
  const root = resolve(cwd, "", P);
  if (abs === root) return false;
  const rel = P.relative(root, abs);
  // Canonical containment idiom: `..env` (a legal workspace filename) also
  // starts with ".." but is INSIDE the root — only the exact parent rel or a
  // true `..`+separator prefix escapes it.
  return rel === ".." || rel.startsWith(".." + P.sep) || P.isAbsolute(rel);
}

// Tools that take a path and can trigger the external_directory boundary.
const PATH_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"]);

// Tools to surface in the UI when "ask" fires. Control characters are
// flattened and long commands/paths clipped so untrusted command text can't
// reshape the dialog.
function describe(toolName: string, input: Record<string, unknown> | undefined): string {
  const clip = (s: unknown): string => {
    const c = String(s).replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
    return c.length > 120 ? c.slice(0, 120) + "…" : c;
  };
  if (toolName === "bash") return `\`bash\`: ${clip(input?.command || "")}`;
  if (input?.path) return `\`${toolName}\`: ${clip(input.path)}`;
  return `\`${toolName}\``;
}

// Session-scoped allowlist for "Allow for this session" promotions. Module
// state — settings are re-read from disk on every tool_call, so promotions
// cannot live on the (ephemeral) rules object.
const sessionAllows = new Map<string, Set<string>>(); // toolName → Set<subject>

function promoteToSessionAllow(toolName: string, subject: string): void {
  if (!sessionAllows.has(toolName)) sessionAllows.set(toolName, new Set());
  sessionAllows.get(toolName)!.add(subject);
}

function sessionAllowed(toolName: string, subject: string): boolean {
  return sessionAllows.get(toolName)?.has(subject) === true;
}

/**
 * Persist an "allow" rule for this exact (tool, subject) into the settings.json
 * that already carries the permission config (same resolution order as
 * readSettingsKey); if none exists, create <cwd>/.pi/settings.json.
 * Returns { file } on success or { error } on failure.
 * Exported for unit testing (dirs overrides the search list).
 */
export function persistAllowlistRule(
  toolName: string,
  subject: string,
  ctx: { cwd?: string } | undefined,
  dirs?: string[],
): { file?: string; error?: string } {
  try {
    // A subject bearing wildcards (e.g. `git add *`) would be stored as a
    // glob pattern far broader than what the user approved — refuse.
    if (/[\x2a\x3f]/.test(String(subject))) {
      return { error: `subject contains wildcard characters (* or ?): ${String(subject)} — add the rule manually` };
    }
    const home = os.homedir();
    const search = dirs ?? [
      nodePath.join(ctx?.cwd || process.cwd(), ".pi"),
      process.env.PI_CODING_AGENT_DIR || nodePath.join(home, ".pi", "agent"),
      nodePath.join(home, ".pi", "agents"),
    ];
    let target = search[0]!;
    for (const dir of search) {
      try {
        const existing = JSON.parse(readFileSync(nodePath.join(dir, "settings.json"), "utf8")) as Record<string, unknown>;
        const perm = existing?.permission;
        if (perm && typeof perm === "object" && !Array.isArray(perm)) {
          target = dir;
          break;
        }
      } catch { /* no/invalid settings.json here — keep looking */ }
    }
    mkdirSync(target, { recursive: true });
    const file = nodePath.join(target, "settings.json");
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
        // An existing-but-unparseable settings.json must never be overwritten.
        return { error: `settings.json at ${file} is not valid JSON; not overwriting` };
      }
      parsed = {};
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) parsed = {};
    const prev = parsed.permission;
    const perm: Record<string, unknown> = prev && typeof prev === "object" && !Array.isArray(prev) ? (prev as Record<string, unknown>) : {};
    const prevRules = perm[toolName];
    const toolRules: RuleMap = prevRules && typeof prevRules === "object" && !Array.isArray(prevRules) ? { ...(prevRules as RuleMap) } : {};
    if (typeof prevRules === "string") toolRules["*"] = prevRules; // whole-tool rule kept as `*` (inserted first, specific allow still wins)
    // Re-append the subject LAST so the explicit allow wins (last-match-wins),
    // even when the same key already existed earlier in insertion order.
    delete toolRules[String(subject)];
    toolRules[String(subject)] = "allow";
    perm[toolName] = toolRules;
    parsed.permission = perm;
    // Atomic write: temp file + rename so a crash can't truncate settings.json.
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(parsed, null, 2) + "\n");
    renameSync(tmp, file);
    return { file };
  } catch (e) {
    return { error: String((e as Error)?.message || e) };
  }
}

/**
 * One-time-per-session warning for permission rules that parse but can never
 * match: a string-valued `external_directory` (resolveRule only handles rule
 * objects) or an unknown action verb (treated as no-opinion — the rule
 * silently no-ops). Best-effort via ctx.ui.notify; fires at most once.
 */
let warnedInvalidRules = false;
export function resetInvalidRulesWarning(): void {
  warnedInvalidRules = false;
}
function warnInvalidRules(rules: PermissionRules, ctx: ExtensionContext | undefined): void {
  if (warnedInvalidRules) return;
  const problems: string[] = [];
  if (typeof rules.external_directory === "string") {
    problems.push('external_directory must be a rule object ({"pattern":"action"}), not a string');
  }
  for (const [tool, r] of Object.entries(rules)) {
    const vals: string[] =
      r && typeof r === "object" && !Array.isArray(r)
        ? (tool === "external_directory" ? [] : (Object.values(r) as string[]))
        : [r as string];
    for (const v of vals) {
      if (!ACTIONS.has(v)) {
        problems.push(`unknown action ${JSON.stringify(v)} in "${tool}" rules`);
        break;
      }
    }
  }
  if (problems.length === 0) return;
  warnedInvalidRules = true;
  try {
    ctx?.ui?.notify(`Invalid permission rules ignored: ${problems.join("; ")}`, "warning");
  } catch { /* best-effort */ }
}

interface ResolvedCall {
  block: true;
  reason: string;
}

/** Test seam: lets a test drive the win32 code paths (drive-letter subjects,
 *  backslash containment) on a posix host — production passes nothing and
 *  node:path picks the platform module. */
interface PathCtx {
  home?: string;
  ppath?: typeof nodePath.posix | typeof nodePath.win32;
}

export default function permissionModule(pi: ExtensionAPI): void {
  // yolo mode auto-approves "ask" without prompting; explicit deny still holds.
  pi.registerFlag("yolo", {
    description: "Auto-approve all permission prompts (deny rules still enforced)",
    type: "boolean",
  });
  pi.registerFlag("auto", {
    description: "Alias for --yolo (auto-approve permission prompts)",
    type: "boolean",
  });

  // CLI flags are immutable after parse; capture once at load so event
  // handlers never touch the captured pi API (stale after session
  // replacement/reload — getFlag throws there).
  let yolo = false;
  let auto = false;
  try {
    yolo = Boolean(pi.getFlag("yolo"));
    auto = Boolean(pi.getFlag("auto"));
  } catch {
    yolo = false;
    auto = false;
  }

  // doom-loop state: ring of recent (tool, inputKey) signatures
  const recent: string[] = [];
  const DOOM_THRESHOLD = 3;

  // Rule resolution for a tool call: undefined = allow, { block, reason } =
  // deny. Doom-loop counting lives in the handler wrapper below.
  async function resolveCall(rules: PermissionRules, event: ToolCallEvent, ctx: ExtensionContext): Promise<ResolvedCall | undefined> {
    const { toolName, input } = event;
    const home = (ctx as { home?: string }).home || process.env.HOME || "";
    const inp = input as Record<string, unknown> | undefined;

    // ── Rule resolution ────────────────────────────────────────────────
    // external_directory is a deny-only boundary gate: a path outside cwd is
    // blocked only if the matched external rule is "deny". Allow/null lets the
    // path through to normal tool rules (OpenCode semantics: a directory allowed
    // here inherits workspace defaults, it is not blanket-trusted).
    if (PATH_TOOLS.has(toolName) && rules.external_directory && typeof rules.external_directory === "object") {
      // Expand ~ BEFORE the boundary check: on the raw path, `~/ext/file`
      // resolves relative to cwd (e.g. /proj/~/ext/file) → classified internal
      // → the deny gate never fired, while the path tool expands ~ to an
      // external file. resolveRule already expanded; the gate must too.
      // Empty home → expandHome is identity → behavior unchanged.
      const subj = expandHome(String(inp?.path || ""), home);
      if (isExternal(subj, ctx.cwd, (ctx as PathCtx).ppath) && resolveRule(rules.external_directory, subj, home) === "deny") {
        return { block: true, reason: "denied by permission rule (external_directory)" };
      }
    }

    let action: string | null = null;
    let matchedRule = "(default)";

    // 1. tool-specific rules (expand ~ for path patterns so rules can reference $HOME)
    if (rules[toolName] !== undefined) {
      const toolRules = rules[toolName];
      if (typeof toolRules === "string") {
        action = toolRules;
        matchedRule = toolName + " (whole)";
      } else {
        if (PATH_TOOLS.has(toolName)) {
          const { rel, abs } = normalizedSubjects(String(inp?.path || ""), ctx.cwd, home, (ctx as PathCtx).ppath);
          action = resolvePathAction(toolRules, rel, abs, home);
        } else {
          action = resolveRule(toolRules, toolSubject(toolName, inp), home);
        }
        matchedRule = toolName;
      }
    }

    // 2. global "*" default
    if (action === null && rules["*"] !== undefined) {
      action = String(rules["*"]);
      matchedRule = "*";
    }

    // Validate action is a known verb; unknown values (e.g. an object placed at
    // "*") are treated as no-opinion so a misconfig can't accidentally block.
    if (action !== null && !ACTIONS.has(action)) {
      action = null;
    }

    // No rule matched → allow (no opinion).
    if (action === null || action === "allow") return undefined;
    if (action === "deny") {
      return { block: true, reason: `denied by permission rule (${matchedRule})` };
    }

    // Session promotions key on the NORMALIZED RELATIVE subject for path
    // tools (what "Add to permanent allowlist" wrote for a relative rule) —
    // win32 cwd tests drive path.win32 via the ctx shim.
    const sessionSubject = PATH_TOOLS.has(toolName)
      ? normalizedSubjects(String(inp?.path || ""), ctx.cwd, home, (ctx as PathCtx).ppath).rel
      : toolSubject(toolName, inp);
    if (sessionAllowed(toolName, sessionSubject)) return undefined;

    // ── "ask" ───────────────────────────────────────────────────────
    if (yolo || auto) return undefined; // auto-approve (--yolo or --auto)

    if (!ctx.hasUI) {
      // Non-interactive: can't ask → block by default (fail closed).
      return { block: true, reason: `requires approval (no UI): ${matchedRule}` };
    }

    try {
      const subject = sessionSubject;
      // Subject-less tools (no command/path to key on) get no remember options.
      const options = subject
        ? ["Allow once", "Allow for this session", "Add to permanent allowlist", "Deny"]
        : ["Allow once", "Deny"];
      const choice = await ctx.ui.select(
        `Permission required (${matchedRule}):\n\n  ${describe(toolName, inp)}`,
        options,
      );
      if (choice === "Allow for this session") {
        promoteToSessionAllow(toolName, subject);
        return undefined;
      }
      if (choice === "Add to permanent allowlist") {
        // Trust gate mirrors the read path: in an untrusted project the rule
        // must land in global scope — writing cwd/.pi/settings.json would be
        // a silent no-op (that file is not read there) and modifies a
        // repo-controlled file.
        const trusted = ctx?.isProjectTrusted?.() === true;
        const written = trusted
          ? persistAllowlistRule(toolName, subject, ctx)
          : persistAllowlistRule(toolName, subject, ctx, [
              process.env.PI_CODING_AGENT_DIR || nodePath.join(os.homedir(), ".pi", "agent"),
              nodePath.join(os.homedir(), ".pi", "agents"),
            ]);
        if (written.error) {
          return { block: true, reason: `could not persist allowlist rule: ${written.error}` };
        }
        promoteToSessionAllow(toolName, subject); // cover the rest of this session too
        try {
          ctx.ui.notify(`Permission rule added to ${written.file}: ${describe(toolName, inp)} → allow`, "info");
        } catch { /* best-effort */ }
        return undefined;
      }
      if (choice !== "Allow once") {
        // "Deny" or dismissed dialog (Esc) — fail closed.
        return { block: true, reason: `denied by user (${matchedRule})` };
      }
      return undefined; // Allow once
    } catch {
      return { block: true, reason: `approval prompt failed (${matchedRule})` };
    }
  }

  pi.on("tool_call", async (event, ctx) => {
    // Plan mode owns tool gating while it is active (its confirm tiers cover
    // the same calls) — a second prompt would be double prompting.
    if (isPlanActive()) return undefined;

    // Settings.json first (production), then the legacy getSetting stub (tests).
    // Project scope is trust-gated: settings.json in an untrusted checkout must
    // not shadow the user's global rules.
    const rules =
      (readSettingsKey(ctx?.cwd, "permission", {
        project: ctx?.isProjectTrusted?.() === true,
      }) as PermissionRules | undefined) ??
      ((pi as unknown as { getSetting?: (k: string) => PermissionRules | undefined }).getSetting?.("permission") ?? undefined);
    if (!rules) return undefined; // not configured → no opinion
    warnInvalidRules(rules, ctx);

    // ── Doom-loop guard ────────────────────────────────────────────────
    // Block the Nth identical consecutive call. Cheap insurance vs model loops.
    // Only allowed/ask outcomes count toward the ring: repeated DENIED calls
    // must keep reporting the real deny reason, not a doom-loop mask.
    const { toolName } = event;
    const sig = JSON.stringify({ toolName, input: event.input });
    const lastN = recent.slice(-(DOOM_THRESHOLD - 1));
    if (lastN.length === DOOM_THRESHOLD - 1 && lastN.every((s) => s === sig)) {
      try {
        ctx.ui.notify(`Doom-loop blocked: \`${toolName}\` repeated ${DOOM_THRESHOLD}×`, "warning");
      } catch { /* best-effort */ }
      return { block: true, reason: `doom-loop: ${toolName} repeated ${DOOM_THRESHOLD} times` };
    }

    const result = await resolveCall(rules, event, ctx);
    if (!result?.block) {
      recent.push(sig);
      if (recent.length > DOOM_THRESHOLD) recent.shift();
    }
    return result;
  });

  // Reset doom-loop + session-allow memory on new session so a prior session's
  // calls don't poison the new one when pi reuses the extension process.
  pi.on("session_start", () => { recent.length = 0; sessionAllows.clear(); resetInvalidRulesWarning(); });
}
