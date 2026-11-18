import { commandLooksLikeSemanticCodeSearch, pathLooksLikeCode, pathLooksNonSemantic } from "./detect";

export const SERENA_FIRST_GUIDANCE = "Serena-first code navigation: before reading whole code files for code navigation, call Serena first — its navigation tools are declared. For named source files, start with serena_get_symbols_overview(relative_path=...). For named functions/classes/methods/variables, use serena_find_symbol. Use serena_find_referencing_symbols before behavior changes or renames, and serena_find_declaration / serena_find_implementations for definitions, interfaces, and implementations. Use read/grep/find for docs, configs, non-code files, exact text checks, or narrow code ranges after Serena identifies the target.";

export const SERENA_MISS_GUIDANCE = "Use serena_get_symbols_overview for source-file outlines or serena_find_symbol for named symbols before reading/searching code. Use read after Serena identifies the relevant region, or for docs/config/non-code files.";

/**
 * Is Serena's tool surface actually usable in this session? Serena tools
 * The seven NAVIGATION tools register DIRECT (2026-11-18 usage re-eval) so
 * they are declared from request #1; the editing tail stays deferred and
 * loads on a tool_search call. Active `serena_find_symbol` means the direct
 * tier is live; active `tool_search` means one search away (the pre-2026-11-18
 * state, still honored for a plan-mode/older-server session). Exported pure
 * predicate so the hook and its tests share one definition.
 */
export function isSerenaActive(activeTools: readonly string[] | undefined): boolean {
  if (!Array.isArray(activeTools)) return false;
  return activeTools.includes("serena_find_symbol") || activeTools.includes("tool_search");
}

const BLOCKED_TOOLS = new Set(["read", "bash"]);

export function shouldBlockSemanticMiss(toolName: string, input: Record<string, unknown>): boolean {
  if (!BLOCKED_TOOLS.has(toolName)) return false;
  if (toolName === "read") return pathLooksLikeCode(input.path) && !pathLooksNonSemantic(input.path);
  if (toolName === "bash") {
    const command = input.command;
    return typeof command === "string" && commandLooksLikeSemanticCodeSearch(command);
  }
  return false;
}
