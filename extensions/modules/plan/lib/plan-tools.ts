// ponytail: vendored from @bacnh85/pi-plan 0.16.6 (extensions/lib/plan-tools.ts),
// trimmed to ceulen's tool surface (subagent/webfetch-era tools and the
// flow-review tooling are gone). Keep in sync when a ceulen module adds a
// mutating tool — a new mutator MUST land in BLOCKED_TOOLS, not the confirm tier.

/** Known read-only/research tools auto-allowed in plan mode. Tools not in this
 *  set require confirmation (or a hard block when they are mutators). */
export const READ_ONLY_TOOLS = new Set([
  // Built-in reads
  "read", "grep", "find", "ls",
  // Plan tools (path-constrained to the plans dir, safe in plan mode)
  "write_plan", "ask_user_question",
  // FFF tools
  "ffgrep", "fffind", "fff_multi_grep", "resolve_file", "related_files",
  // Serena read-only
  "serena_status", "serena_list_tools", "serena_get_current_config",
  "serena_check_onboarding_performed", "serena_get_symbols_overview", "serena_find_symbol",
  "serena_find_declaration", "serena_find_implementations", "serena_find_referencing_symbols",
  "serena_search_for_pattern", "serena_get_diagnostics_for_file",
  // Munin read-only
  "munin_search", "munin_get", "munin_list", "munin_recent", "munin_capabilities",
  // Advisor returns guidance only; it has no filesystem tools.
  "advisor",
  // ux_audit is pure computation over a CSS string — no fs/network side effects.
  "ux_audit",
  // Decision model: typed questions about caller-supplied state, no side effects.
  "classify",
  // GitHub tool — v1 surface is strictly read-only (views, searches, run_watch);
  // mutating ops must never be added without re-checking this tier.
  "github",
  // NOTE: herdr is deliberately NOT here — its prompt action can drive a
  // write-capable child, so every herdr call takes the confirm tier.
]);

/** Tools that are never available in plan mode — direct source/system mutators. */
export const BLOCKED_TOOLS = new Set([
  // File mutation
  "edit", "write",
  // Diff-style file mutation — same treatment as edit/write.
  "apply_patch",
  // File editor (create/str_replace/insert) — a direct source mutator like edit/write.
  "str_replace_editor",
  // Serena file mutation (restart/onboarding tools are state-changing but no
  // source mutation — they stay at the confirm tier by omission from READ_ONLY)
  "serena_replace_symbol_body", "serena_insert_before_symbol",
  "serena_insert_after_symbol", "serena_rename_symbol",
  "serena_safe_delete_symbol", "serena_replace_content",
  // Munin mutation
  "munin_store", "munin_delete", "munin_share",
]);

/** First-token set: interpreters/wrappers run arbitrary payloads, so their
 *  session-scoped allow key must be the FULL command, not the first token. */
export const INTERPRETER_TOKENS = new Set([
  "node", "npx", "python", "python3", "bash", "sh", "zsh", "deno", "bun",
  "make", "cargo", "go", "ruby", "perl", "awk", "eval",
]);

/** Tools whose mutations are gated by another extension's own parameter
 *  (subagent): plan mode allows the call only when EVERY named agent resolves
 *  read-only, else it takes the confirm tier. */
export function extractSubagentNames(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const obj = input as Record<string, unknown>;
  const names: string[] = [];
  if (typeof obj.agent === "string") names.push(obj.agent);
  if (Array.isArray(obj.tasks)) for (const t of obj.tasks) if (t && typeof t === "object" && typeof (t as { agent?: unknown }).agent === "string") names.push((t as { agent: string }).agent);
  if (Array.isArray(obj.chain)) for (const c of obj.chain) if (c && typeof c === "object" && typeof (c as { agent?: unknown }).agent === "string") names.push((c as { agent: string }).agent);
  return [...new Set(names)];
}

/** Guidance appended to the plan-mode system prompt (Serena/FFF-first research
 *  and what auto-runs vs. prompts). */
export const PLAN_MODE_RESEARCH_GUIDANCE =
  "Tool selection for code research: for source files, symbols, functions, classes, declarations, references, implementations, and refactors, use Serena before raw reads/searches. Use serena_get_symbols_overview for source-file outlines; serena_find_symbol for named functions/classes/methods/variables; serena_find_referencing_symbols before behavior changes or renames; and serena_find_declaration / serena_find_implementations for definitions, interfaces, and implementations. Use read for docs/config/non-code files, exact line ranges, or after Serena identifies the relevant code region. Prefer the dedicated ls/ffgrep/fffind tools over shell commands; fall back to grep/find when the fff tools are unavailable. Strict single read-only shell commands run automatically; test, build, and package scripts require confirmation because they may modify files. Pipelines and chains of read-only commands (ls, grep, find, cat, head, tail, jq, print-only sed, xargs over read tools, tar -t/-xO, read-only git subcommands) plus cd && chains and VAR=value prefixes run without prompting; $(), backticks, file redirects, heredocs, interpreters like python3 -c / node -e, and test/build/package scripts prompt or hard-block — keep research to the auto-run forms.";
