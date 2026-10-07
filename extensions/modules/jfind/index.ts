// jfind — semantic code find: describe what code does, get files + line
// ranges. Ported from OMP's jfind cascade; the judge routes through pi's
// modelRegistry.classify (System One via the router provider).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { Type } from "typebox";
import { readDisabledTools } from "../../lib/tools.js";
import { formatBytes } from "./lib/format.js";
import { runCascade, FIND_TIMEOUT_MS, type CascadeResult } from "./lib/cascade.js";
import { createJudge } from "./lib/judge.js";
import { rankedHeat } from "./lib/tree.js";

/** Line ranges shown per hit in the model-facing text, strongest first. */
const RANGES_SHOWN = 3;

function formatBytesCeulen(bytes: number): string {
  return formatBytes(bytes);
}

export default function jfindModule(pi: ExtensionAPI): void {
  const disabled = readDisabledTools();
  pi.registerTool({
    name: "jfind",
    label: "Semantic Find",
    defaultActive: !disabled.has("jfind"),
    description:
      "Semantic code find: describe a BEHAVIOR (\"where do we parse CLI flags\", \"retry with backoff around provider calls\") and get the files and line ranges that implement it, strongest first. " +
      "A lexical keyword scan ranks candidates, then a System One judge (the router's classifier models) ranks filenames, passage sketches, and full passages in three waves. " +
      "Use when grep/ffgrep can't phrase the search as a literal pattern; needs a classifier model to be configured (router catalog). Slower than grep (a few seconds of judging). " +
      "The `path` scope accepts a directory OR a single file (a deny-listed/binary/secret/empty file is refused with a reason).",
    promptSnippet: "Semantic find: locate code by describing what it does",
    promptGuidelines: [
      "Describe the behavior, not the keywords: jfind judges passages semantically.",
      'Put must-have identifiers in quotes ("spawn", "writeStdin") — quoted phrases become hard lexical keywords.',
      "No hits doesn't mean the code doesn't exist — fall back to ffgrep/fffind for literal patterns.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: 'What the code does, e.g. "parse cron expressions into next-fire times".' }),
      keywords: Type.Optional(Type.Array(Type.String(), { description: "Extra literal keywords folded into the lexical prior." })),
      path: Type.Optional(Type.String({ description: "Search scope: a directory (default the session cwd) or a single file." })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const query = (params.query as string).trim();
      if (query.length === 0) throw new Error("`query` must be a non-empty description");
      const cwd = ctx?.cwd || process.cwd();
      const scopeInput = typeof params.path === "string" ? params.path.trim() : "";
      let root = resolvePath(cwd);
      if (scopeInput.length > 0) {
        root = resolvePath(cwd, scopeInput);
        if (!existsSync(root)) throw new Error(`Path not found: ${scopeInput}`);
        if (!statSync(root).isFile() && !statSync(root).isDirectory()) {
          throw new Error(`Path is neither a file nor a directory: ${scopeInput}`);
        }
      }
      let judge;
      try {
        judge = createJudge(ctx);
      } catch (err) {
        return {
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          isError: true as const,
          details: { query },
        };
      }
      const timeout = AbortSignal.timeout(FIND_TIMEOUT_MS);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let result: CascadeResult;
      try {
        result = await runCascade({
          root,
          query,
          extraKeywords: (params.keywords as string[] | undefined) ?? [],
          judge,
          signal: combined,
          onProgress: (message) => onUpdate?.({ content: [{ type: "text", text: message }], details: undefined }),
        });
      } catch (err) {
        if (timeout.aborted && !signal?.aborted) {
          throw new Error(`jfind timed out after ${Math.round(FIND_TIMEOUT_MS / 1000)}s — narrow the query or scope (path param)`);
        }
        throw err;
      }
      // A single-file scope that lists zero eligible files used to fall through
      // to a silent "no hits" — surface the eligibility refusal instead.
      if (result.stats.listed === 0 && scopeInput.length > 0 && statSync(root).isFile()) {
        return {
          content: [{ type: "text", text: `not searchable: ${scopeInput} (deny-listed, binary, secret, or empty by jfind's eligibility rules)` }],
          details: { query },
        };
      }
      const { stats, threshold, keywords } = result;
      const scope = scopeInput.length > 0 ? ` in ${scopeInput}` : "";
      const out: string[] = [];
      if (result.hits.length === 0) {
        out.push(`no hits for "${query}"${scope} (τ ${threshold.toFixed(2)})`);
      } else {
        out.push(`${result.hits.length} hit(s) for "${query}"${scope} (τ ${threshold.toFixed(2)}), strongest first`, "");
        for (const hit of result.hits) {
          const coverage = hit.truncated ? `${hit.linesSeen} lines judged, partial` : `${hit.linesSeen} lines judged`;
          out.push(`${hit.rel}  ${hit.contentScore.toFixed(2)}  ${coverage}`);
          for (const range of rankedHeat(hit.ranges, RANGES_SHOWN)) {
            const span = range.start === range.end ? String(range.start) : `${range.start}-${range.end}`;
            out.push(`  ${hit.rel}:${span}  ${range.p.toFixed(2)}  ${range.snippet}`);
          }
        }
      }
      out.push(
        "",
        `listed ${stats.listed} · judged ${stats.judged} · read ${stats.filesRead} files (${formatBytesCeulen(stats.fileBytes)}) · ${stats.requests} requests · ${stats.inputTokens + stats.outputTokens} tokens · keywords: ${keywords.join(", ")}`,
      );
      if (stats.failures.length > 0) {
        out.push(`${stats.errors} of ${stats.requests} requests failed:`, ...stats.failures.map((f) => `  ${f}`));
      }
      const allFailed = stats.requests > 0 && stats.errors === stats.requests;
      return {
        content: [{ type: "text", text: out.join("\n") }],
        isError: allFailed,
        details: { query, keywords, threshold, hits: result.hits.length, stats },
      };
    },
  });
}
