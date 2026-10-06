// sg module — structural search & rewrite via the ast-grep CLI (gh-module
// fail-open pattern): `ast_grep` search + `ast_edit` multi-op rewrites with a
// dry-run default. Missing binary → the module registers nothing and the
// /config Enable row stays reachable.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readDisabledTools } from "../../lib/tools.js";
import { realSg, sgAvailable, type SgRunner } from "./lib/sg-cli.js";
import { buildRunArgs, formatMatches, mergeMatches, parseSearch } from "./lib/ops.js";

const LANGUAGE_PARAM = Type.Optional(
  Type.String({ description: 'Tree-sitter language id when the files\' extension is ambiguous — "ts", "tsx", "py", "rust", "go", "java"… (optional; inferred from the extension).' }),
);

async function runSearch(rg: SgRunner, cwd: string, opts: { pattern: string; language?: string; globs?: string[]; paths?: string[] }, signal?: AbortSignal) {
  return parseSearch(await rg.run(cwd, buildRunArgs({ ...opts, json: true }), signal), opts.pattern);
}

export default function sgModule(pi: ExtensionAPI): void {
  // No sg/ast-grep binary → no tools; /config's Enable row still renders
  // (install + /reload activates).
  if (!sgAvailable()) return;

  const disabled = readDisabledTools();

  pi.registerTool({
    name: "ast_grep",
    label: "AST Grep",
    defaultActive: !disabled.has("ast_grep"),
    description:
      "Structural code search via the ast-grep CLI: match AST patterns with meta-variables ($VAR = one node, $$$ALL = many) instead of regex — `$FUNC($$$ARGS)` finds every call. " +
      "Patterns are snippets of real code in the target language. Use for syntax-aware searches regex mangles (calls, imports, JSX). Returns path:line:col + matched text.",
    promptSnippet: "Structural AST code search (ast-grep patterns)",
    promptGuidelines: [
      "Write the pattern as real code with $NAME holes; it must parse in the target language.",
      "Prefer this over regex grep when the shape of the code matters (calls, assignments, JSX tags).",
      "A pattern that fails to parse returns a hint — simplify the pattern or set `language`.",
    ],
    parameters: Type.Object({
      pattern: Type.String({ description: "ast-grep pattern (real code with $VAR / $$$ALL meta-variables)." }),
      patterns: Type.Optional(Type.Array(Type.String(), { description: "Extra OR patterns — each is searched and results are merged+deduped." })),
      language: LANGUAGE_PARAM,
      globs: Type.Optional(Type.Array(Type.String(), { description: 'Glob filter, e.g. ["*.ts", "!*.test.ts"].' })),
      paths: Type.Optional(Type.Array(Type.String(), { description: 'Files/directories to search (default ["."]).' })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = ctx?.cwd || process.cwd();
      const p = params as { pattern: string; patterns?: string[]; language?: string; globs?: string[]; paths?: string[] };
      const all = [p.pattern, ...(p.patterns ?? [])];
      try {
        const runs = await Promise.all(
          all.map((pattern) => runSearch(realSg, cwd, { pattern, language: p.language, globs: p.globs, paths: p.paths }, signal)),
        );
        const merged = mergeMatches(runs);
        const patternError = merged.patternError;
        if (patternError) {
          return { content: [{ type: "text", text: patternError }], isError: true as const, details: { pattern: p.pattern } };
        }
        return {
          content: [{ type: "text", text: formatMatches(merged.matches, all.join(" | ")) }],
          details: { matches: merged.matches.length },
        };
      } catch (err) {
        return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true as const, details: { pattern: p.pattern } };
      }
    },
  });

  pi.registerTool({
    name: "ast_edit",
    label: "AST Edit",
    defaultActive: !disabled.has("ast_edit"),
    description:
      "Structural code rewrite via the ast-grep CLI: one pattern → rewrite pair applied across files (the rewrite reuses $VAR / $$$ALL meta-variables). " +
      "DRY-RUN BY DEFAULT: returns the per-file diff without touching disk. Pass write:true to apply (files are rewritten in place; NOT atomic across files). " +
      "After applying, the match count is re-checked and reported so silent misses (a rewrite that generates new matches) are visible.",
    promptSnippet: "Structural AST rewrite (ast-grep), dry-run by default",
    promptGuidelines: [
      "Always inspect the dry-run diff before write:true — rewrites apply to every match in scope.",
      "The rewrite is a code template reusing the pattern's meta-variables ($VAR stays, text around it changes).",
      "Scope rewrites with paths/globs; use for mechanical multi-file refactors, not one-line edits (edit wins there).",
    ],
    parameters: Type.Object({
      pattern: Type.String({ description: "ast-grep pattern (real code with $VAR / $$$ALL meta-variables)." }),
      rewrite: Type.String({ description: "Rewrite template reusing the pattern's meta-variables." }),
      language: LANGUAGE_PARAM,
      globs: Type.Optional(Type.Array(Type.String(), { description: 'Glob filter, e.g. ["src/**"].' })),
      paths: Type.Optional(Type.Array(Type.String(), { description: 'Files/directories to rewrite (default ["."]).' })),
      write: Type.Optional(Type.Boolean({ default: false, description: "false (default) = dry-run diff only; true = rewrite the files on disk." })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = ctx?.cwd || process.cwd();
      const p = params as { pattern: string; rewrite: string; language?: string; globs?: string[]; paths?: string[]; write?: boolean };
      try {
        const before = await runSearch(realSg, cwd, { pattern: p.pattern, language: p.language, globs: p.globs, paths: p.paths }, signal);
        if (before.patternError) {
          return { content: [{ type: "text", text: before.patternError }], isError: true as const, details: { pattern: p.pattern } };
        }
        if (before.noMatches) {
          return { content: [{ type: "text", text: `no matches for ${p.pattern} — nothing to rewrite` }], details: { matches: 0 } };
        }
        if (p.write !== true) {
          const preview = await realSg.run(cwd, buildRunArgs({ pattern: p.pattern, rewrite: p.rewrite, language: p.language, globs: p.globs, paths: p.paths }), signal);
          const files = [...new Set(before.matches.map((m) => m.file))];
          let text = `DRY-RUN — ${before.matches.length} match(es) across ${files.length} file(s) would change:\n${files.map((f) => `  ${f}`).join("\n")}\n\n${preview.stdout.trim()}`;
          if (text.length > 16_000) text = `${text.slice(0, 16_000)}\n[… preview truncated — narrow paths/globs …]`;
          return { content: [{ type: "text", text }], details: { matches: before.matches.length, files } };
        }
        const apply = await realSg.run(cwd, buildRunArgs({ pattern: p.pattern, rewrite: p.rewrite, language: p.language, globs: p.globs, paths: p.paths, update: true }), signal);
        if (apply.exitCode !== 0) {
          throw new Error(`sg -U rewrite failed (exit ${apply.exitCode}): ${apply.stderr.slice(0, 300) || apply.stdout.slice(0, 300)}`);
        }
        // Staleness check: a rewrite that produces fresh matches means the
        // rule isn't idempotent — surface it instead of silently looping
        // later callers into re-applying.
        const after = await runSearch(realSg, cwd, { pattern: p.pattern, language: p.language, globs: p.globs, paths: p.paths }, signal);
        const files = [...new Set(before.matches.map((m) => m.file))];
        let text = `rewrote ${before.matches.length} match(es) across ${files.length} file(s):\n${files.map((f) => `  ${f}`).join("\n")}`;
        if (!after.noMatches) {
          text += `\nnote: ${after.matches.length} match(es) REMAIN post-rewrite — the rewrite generates new matches for its own pattern; re-running would loop.`;
        }
        return { content: [{ type: "text", text }], details: { matches: before.matches.length, files, remaining: after.matches.length } };
      } catch (err) {
        return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true as const, details: { pattern: p.pattern } };
      }
    },
  });
}
