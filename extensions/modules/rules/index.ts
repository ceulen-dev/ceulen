// rules module — sticky RULES.md + on-demand rulebook.
//
// Ported CONTRACT (not code) from OMP's sticky RULES.md + rulebook split
// (omp/docs/context-files.md "Sticky rules vs normal context",
// omp/docs/rulebook-matching-pipeline.md §5 bucket split,
// omp/packages/coding-agent/src/capability/rule.ts). The file format is
// documented at the top of ./lib/rules.ts.
//
// Surfaces:
//   - ONE `before_agent_start` handler: append-only composition exactly like the
//     fff module (returns `{ systemPrompt: \`${event.systemPrompt}\n\n${block}\` }`
//     or undefined when no RULES.md exists anywhere — zero footprint by default).
//   - ONE tool `rule_get` (name) serving a rulebook rule's body on demand.
//   - `/rules` status + `/rules reload` (drops the mtime cache).
//
// Registered in a guarded()`-deduped bundle: no attempt is made to own the
// rules — dropping the module (or never wiring it) restores vanilla pi.

import type {
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { clearRuleCache, loadRules, type RuleModel } from "./lib/rules";

/** Cap on a single rule body returned by rule_get (chars). */
const RULE_GET_MAX_CHARS = 20000;

/** Trust gate (AGENTS.md/subagent convention): an untrusted checkout's
 *  RULES.md must not reach the system prompt or rule_get. Fail closed. */
function projectTrusted(ctx: { isProjectTrusted?: () => boolean } | undefined): boolean {
  try {
    return ctx?.isProjectTrusted?.() === true;
  } catch {
    return false;
  }
}

function statusLines(model: RuleModel, cwd: string): string {
  if (model.files.length === 0) {
    return [
      "Rule sources: none",
      "  No .pi/RULES.md found from cwd to the filesystem root, and no user-level ~/.pi/agent/RULES.md.",
      "  Create one to add sticky rules (append-only to the system prompt) or rulebook rules.",
    ].join("\n");
  }
  const names = (rules: { name: string }[]) => rules.map((rule) => rule.name).join(", ") || "(none)";
  return [
    `Rule sources (${model.files.length}):`,
    ...model.files.map((file, index) => `  ${index + 1}. ${file}`),
    `Sticky rules (${model.sticky.length}): ${names(model.sticky)}`,
    `Rulebook rules (${model.rulebook.length}): ${names(model.rulebook)}`,
    "  Bodies are served on demand by rule_get — never listed here.",
    `Prompt block: ${model.blockChars} chars${model.block ? "" : " (no block emitted)"}`,
    `  Sources are resolved nearest-first from ${cwd}; project files override user rules on duplicate names.`,
  ].join("\n");
}

export default function rulesExtension(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event, ctx): Promise<BeforeAgentStartEventResult | undefined> => {
    let model: RuleModel;
    try {
      model = loadRules(ctx?.cwd ?? process.cwd(), undefined, projectTrusted(ctx));
    } catch {
      return undefined; // never break a turn over rule discovery
    }
    if (!model.block) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${model.block}` };
  });

  pi.registerTool({
    name: "rule_get",
    label: "rule_get",
    description:
      "Read the full body of a project rule listed in the <user-rules> rulebook (sticky rules are already in the system prompt).",
    promptSnippet: "Read a rulebook rule's body by name",
    parameters: Type.Object({
      name: Type.String({ description: "Rule name (the `## <name>` heading) from the rulebook listing." }),
    }),
    async execute(_id: string, params: { name: string }, _signal, _onUpdate, ctx) {
      const model = loadRules(ctx?.cwd ?? process.cwd(), undefined, projectTrusted(ctx));
      const wanted = (params.name ?? "").trim();
      const rule = model.rules.find((item) => item.name === wanted);
      if (!rule) {
        const available = model.rules.map((item) => item.name);
        return {
          content: [{
            type: "text" as const,
            text: available.length === 0
              ? `Rule "${wanted}" not found: no RULES.md exists in this workspace (searched .pi/RULES.md from cwd to the filesystem root, plus ~/.pi/agent/RULES.md).`
              : `Rule "${wanted}" not found. Available rules: ${available.join(", ")}`,
          }],
          details: { found: false, available },
        };
      }
      const body = rule.sticky
        ? `[sticky rule "${rule.name}" — already appended to the system prompt]\n\n${rule.body}`
        : rule.body;
      const clipped = body.length > RULE_GET_MAX_CHARS
        ? `${body.slice(0, RULE_GET_MAX_CHARS)}\n\n[rule body truncated at ${RULE_GET_MAX_CHARS} chars]`
        : body;
      return {
        content: [{ type: "text" as const, text: `${clipped}\n\n(rule "${rule.name}" from ${rule.source})` }],
        details: { found: true, name: rule.name, source: rule.source, sticky: rule.sticky, truncated: clipped !== body },
      };
    },
  });

  pi.registerCommand("rules", {
    description: "Rule sources status, or /rules reload to drop the rule-file cache.",
    handler: async (args: string, ctx: ExtensionContext) => {
      const arg = (args ?? "").trim().toLowerCase();
      if (arg === "reload") {
        clearRuleCache();
        ctx.ui.notify(`[rules] cache dropped — re-reading ${loadRules(ctx.cwd).files.length} source(s)`, "info");
        return;
      }
      if (arg !== "") {
        ctx.ui.notify(`[rules] unknown argument "${arg}" — use /rules or /rules reload`, "error");
        return;
      }
      ctx.ui.notify(statusLines(loadRules(ctx.cwd, undefined, projectTrusted(ctx)), ctx.cwd), "info");
    },
  });
}
