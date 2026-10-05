// gh module — one `github` tool over the `gh` CLI (zero npm deps).
//
// Ported from oh-my-pi's github tool (tools/gh*.ts + utils/github.ts), scoped
// to READ-ONLY ops: repo_view, file_read, pr_view, pr_diff, the five search
// flavors, run_watch. Mutating flows (pr_create/checkout/push) are deferred —
// bash `gh` covers them, and a read-only tool lets plan mode auto-allow it
// (plan-tools.ts READ_ONLY_TOOLS).
//
// Registration is fail-open on a missing `gh` binary: the module loads, the
// Enable row stays reachable, but no tool registers (OMP's createIf pattern)
// until gh is installed.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readDisabledTools } from "../../lib/tools.js";
import { ghAvailable, realGh } from "./lib/gh-cli.js";
import { executeOp } from "./lib/ops.js";

const OP_ENUM = [
  "repo_view", "file_read", "pr_view", "pr_diff",
  "search_issues", "search_prs", "search_code", "search_commits", "search_repos",
  "run_watch",
] as const;

const DESCRIPTION = [
  "Interact with GitHub via the `gh` CLI — repositories, files, pull requests, issues, and Actions.",
  "Read-only operations:",
  "- repo_view: repository metadata (default branch, stars, language, topics).",
  "- file_read: a repository file's contents (text; binary → notice with URL) at an optional branch/ref.",
  "- pr_view: PR metadata, body, files, reviews.",
  "- pr_diff: a PR's unified diff.",
  "- search_issues / search_prs / search_code / search_commits / search_repos: GitHub search with repo/org/user scoping and since/until date filters.",
  "- run_watch: poll a workflow run until it completes; on failure, tails each failed job's logs (`tail` lines per job). Blocks up to ~5 min.",
  "",
  "Prefer these over bash `gh` invocations: repo/ref normalization handles `[host/]owner/repo` and URLs, prompts can never hang, output is capped and structured.",
].join("\n");

export default function ghModule(pi: ExtensionAPI): void {
  // No `gh` binary → no tool; /config's Enable row still renders (the module
  // stays registered in the loader) so installing gh + /reload activates it.
  if (!ghAvailable()) return;

  const disabled = readDisabledTools();
  pi.registerTool({
    name: "github",
    label: "GitHub",
    description: DESCRIPTION,
    promptSnippet: "Interact with GitHub repos, files, PRs, issues, Actions via gh",
    promptGuidelines: [
      "Prefer search_code over web search for code in known GitHub repos; scope with repo:/org:/user: or the repo param.",
      "run_watch blocks until the run finishes — pass `run` plus `tail` to bound log lines.",
      "Read-only surface: create/push/checkout flows go through bash `gh` explicitly.",
    ],
    parameters: Type.Object({
      op: Type.Union(OP_ENUM.map((o) => Type.Literal(o)), { description: "github operation" }),
      repo: Type.Optional(Type.String({ description: "[host/]owner/repo (or full URL where noted); defaults to the cwd checkout." })),
      branch: Type.Optional(Type.String({ description: "branch / ref (file_read, repo_view)." })),
      path: Type.Optional(Type.String({ description: "repository-relative file path (file_read)." })),
      pr: Type.Optional(Type.String({ description: "pr number, url, or branch (pr_view, pr_diff)." })),
      query: Type.Optional(Type.String({ description: "search query (search_* ops)." })),
      since: Type.Optional(Type.String({ description: "lower-bound date filter: relative (3d, 2w) or ISO (search_*, not search_code)." })),
      until: Type.Optional(Type.String({ description: "upper-bound date filter (search_*, not search_code)." })),
      dateField: Type.Optional(Type.Union([Type.Literal("created"), Type.Literal("updated")], { description: "date field for since/until (default created)." })),
      limit: Type.Optional(Type.Number({ description: "max results (search_*; default 10, max 50)." })),
      run: Type.Optional(Type.String({ description: "actions run id or url (run_watch)." })),
      tail: Type.Optional(Type.Number({ description: "failed-job log tail lines (run_watch; default 15, max 200)." })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = ctx?.cwd || process.cwd();
      const p = params as Record<string, unknown>;
      try {
        const result = await executeOp(p.op as string, realGh, cwd, p as never, signal);
        const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
          { type: "text", text: result.text },
        ];
        if (result.image) {
          content.push({ type: "image", data: result.image.data, mimeType: result.image.mimeType });
        }
        return { content, details: { op: p.op, repo: p.repo } };
      } catch (err) {
        return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true, details: undefined };
      }
    },
    defaultActive: !disabled.has("github"),
  });
}
