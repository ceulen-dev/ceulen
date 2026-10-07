// gh module unit tests — every op against an injected GhRunner fake.
// No network, no gh binary: arg building, scoping, formatting, error
// surfacing, and the run_watch poll loop (scripted statuses, tiny intervals).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatGhFailure,
  ghAvailable,
  parseRepoRef,
  repoFromUrl,
  ghApiHostArgs,
  githubRepoSlugEquals,
  type GhCommandOptions,
  type GhRunner,
} from "../lib/gh-cli.js";
import {
  buildSearchDateQualifier,
  executeFileRead,
  executeOp,
  executePrDiff,
  executePrView,
  executeRepoView,
  executeRunWatch,
  executeSearchCode,
  executeSearchIssues,
  executeSearchPrs,
  executeSearchRepos,
  isFailedJob,
  parseRunReference,
  parseSearchDateBound,
  resolveTailLimit,
} from "../lib/ops.js";

/** Scripted fake: maps `gh <first args>` prefixes to canned responses. */
function fakeGh(routes: { match: (args: string[]) => boolean; respond: (args: string[]) => { exitCode?: number; stdout?: string; stderr?: string } }[]): { gh: GhRunner; calls: string[][] } {
  const calls: string[][] = [];
  const gh: GhRunner = {
    async run(_cwd, args) {
      calls.push(args);
      const route = routes.find((r) => r.match(args));
      if (!route) throw new Error(`fakeGh: no route for gh ${args.join(" ")}`);
      const r = route.respond(args);
      return { exitCode: r.exitCode ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    },
    async json(cwd, args, signal, options) {
      const r = await this.run(cwd, args, signal, options);
      if (r.exitCode !== 0) throw new Error(formatGhFailure(args, r.stdout, r.stderr, options));
      return JSON.parse(r.stdout);
    },
    async text(cwd, args, signal, options) {
      const r = await this.run(cwd, args, signal, options);
      if (r.exitCode !== 0) throw new Error(formatGhFailure(args, r.stdout, r.stderr, options));
      return r.stdout;
    },
  };
  return { gh, calls };
}

const CWD = "/tmp/fake-checkout";

describe("repo-ref normalization (gh-cli)", () => {
  it("splits [host/]owner/repo", () => {
    assert.deepEqual(parseRepoRef("owner/repo"), { slug: "owner/repo" });
    assert.deepEqual(parseRepoRef("ghe.example.com/owner/repo"), { host: "ghe.example.com", slug: "owner/repo" });
    assert.deepEqual(parseRepoRef("justaname"), { slug: "justaname" });
  });

  it("keeps non-default hosts in URLs, drops github.com", () => {
    delete process.env.GH_HOST;
    assert.equal(repoFromUrl("https://github.com/a/b"), "a/b");
    assert.equal(repoFromUrl("https://ghe.example.com/a/b"), "ghe.example.com/a/b");
    assert.equal(repoFromUrl("not a url"), undefined);
  });

  it("ghApiHostArgs only names non-default hosts", () => {
    assert.deepEqual(ghApiHostArgs({ slug: "a/b" }), []);
    assert.deepEqual(ghApiHostArgs({ host: "ghe.example.com", slug: "a/b" }), ["--hostname", "ghe.example.com"]);
  });

  it("host-less refs compare against GH_HOST, not as wildcards", () => {
    delete process.env.GH_HOST;
    assert.equal(githubRepoSlugEquals("a/b", "ghe.example.com/a/b"), false);
    assert.equal(githubRepoSlugEquals("a/b", "A/B"), true);
  });
});

describe("search ops", () => {
  it("search_issues scopes to the cwd repo and adds is:issue", async () => {
    const { gh, calls } = fakeGh([
      { match: (a) => a[0] === "repo" && a[1] === "view", respond: () => ({ stdout: "https://github.com/acme/widget" }) },
      { match: (a) => a[0] === "api", respond: () => ({ stdout: JSON.stringify({ total_count: 1, items: [{ number: 7, title: "Bug", state: "OPEN", repository_url: "https://api.github.com/repos/acme/widget" }] }) }) },
    ]);
    const text = await executeSearchIssues(gh, CWD, { query: "crash" });
    assert.match(text, /#7 Bug/);
    assert.match(text, /Repo: acme\/widget/);
    const apiArgs = calls.find((a) => a[0] === "api")!;
    const q = apiArgs.find((x) => x.startsWith("q="))!;
    assert.equal(q, "q=crash repo:acme/widget is:issue");
    assert.ok(apiArgs.includes("/search/issues"));
  });

  it("search_prs uses is:pr over the issues endpoint", async () => {
    const { gh } = fakeGh([
      { match: (a) => a[0] === "repo" && a[1] === "view", respond: () => ({ stdout: "https://github.com/acme/widget" }) },
      { match: (a) => a[0] === "api", respond: () => ({ stdout: JSON.stringify({ items: [] }) }) },
    ]);
    const text = await executeSearchPrs(gh, CWD, { query: "release" });
    assert.match(text, /No pull requests found/);
  });

  it("an explicit repo: qualifier in the query suppresses the default scope", async () => {
    const { gh, calls } = fakeGh([
      { match: (a) => a[0] === "api", respond: () => ({ stdout: JSON.stringify({ items: [] }) }) },
    ]);
    await executeSearchIssues(gh, CWD, { query: "repo:other/thing crash" });
    const apiArgs = calls.find((a) => a[0] === "api")!;
    const q = apiArgs.find((x) => x.startsWith("q="))!;
    assert.equal(q, "q=repo:other/thing crash is:issue");
  });

  it("search_code rejects since/until and passes the text-match header", async () => {
    const { gh } = fakeGh([]);
    await assert.rejects(() => executeSearchCode(gh, CWD, { query: "x", since: "3d" }), /no date qualifier/);
  });

  it("search_code builds the code endpoint query", async () => {
    const { gh, calls } = fakeGh([
      { match: (a) => a[0] === "repo" && a[1] === "view", respond: () => ({ stdout: "https://github.com/acme/widget" }) },
      { match: (a) => a[0] === "api", respond: () => ({ stdout: JSON.stringify({ items: [{ path: "src/a.ts", sha: "abcdef123456", repository: { full_name: "acme/widget" }, text_matches: [{ fragment: "hello world" }] }] }) }) },
    ]);
    const text = await executeSearchCode(gh, CWD, { query: "hello" });
    assert.match(text, /src\/a\.ts/);
    assert.match(text, /Match: hello world/);
    const apiArgs = calls.find((a) => a[0] === "api")!;
    assert.ok(apiArgs.includes("-H") && apiArgs.includes("Accept: application/vnd.github.text-match+json"));
  });

  it("search_repos needs no repo scope", async () => {
    const { gh, calls } = fakeGh([
      { match: (a) => a[0] === "api", respond: () => ({ stdout: JSON.stringify({ items: [{ full_name: "acme/widget", stargazers_count: 42 }] }) }) },
    ]);
    const text = await executeSearchRepos(gh, CWD, { query: "widget" });
    assert.match(text, /acme\/widget/);
    assert.match(text, /Stars: 42/);
    assert.equal(calls.find((a) => a[0] === "repo"), undefined);
  });

  it("since/until compose a date qualifier", () => {
    assert.equal(buildSearchDateQualifier("created", "2026-01-01", "2026-02-01"), "created:2026-01-01..2026-02-01");
    assert.equal(buildSearchDateQualifier("created", "3d", undefined, new Date("2026-10-05T00:00:00Z")), "created:>=2026-10-02");
    assert.equal(parseSearchDateBound("2w", new Date("2026-10-05T00:00:00Z")), "2026-09-21");
  });
});

describe("repo_view / file_read", () => {
  it("repo_view renders metadata", async () => {
    const { gh, calls } = fakeGh([
      { match: (a) => a[0] === "repo", respond: () => ({ stdout: JSON.stringify({ nameWithOwner: "acme/widget", description: "A widget", url: "https://github.com/acme/widget", stargazerCount: 5, defaultBranchRef: { name: "main" } }) }) },
    ]);
    const text = await executeRepoView(gh, CWD, { repo: "acme/widget" });
    assert.match(text, /# acme\/widget/);
    assert.match(text, /Default branch: main/);
    assert.match(text, /Stars: 5/);
    assert.ok(calls[0].includes("--json"));
  });

  it("file_read decodes base64 text and caps size", async () => {
    const content = Buffer.from("hello github").toString("base64");
    const { gh, calls } = fakeGh([
      { match: (a) => a[0] === "api", respond: () => ({ stdout: JSON.stringify({ type: "file", encoding: "base64", content, html_url: "https://github.com/acme/widget/blob/main/README.md" }) }) },
    ]);
    const r = await executeFileRead(gh, CWD, { repo: "acme/widget", path: "README.md" });
    assert.match(r.text, /hello github/);
    const apiArgs = calls.find((a) => a[0] === "api")!;
    assert.ok(apiArgs.some((x) => x.includes("/repos/acme/widget/contents/README.md")));
  });

  it("file_read flags binary content and returns the image block for images", async () => {
    const binary = Buffer.from([0x00, 0x01, 0x02]).toString("base64");
    const png = Buffer.from("89504e47", "hex").toString("base64");
    const { gh } = fakeGh([
      { match: (a) => a.some((x) => String(x).includes("bin.dat")), respond: () => ({ stdout: JSON.stringify({ encoding: "base64", content: binary }) }) },
      { match: (a) => a.some((x) => String(x).includes("img.png")), respond: () => ({ stdout: JSON.stringify({ encoding: "base64", content: png }) }) },
    ]);
    const bin = await executeFileRead(gh, CWD, { repo: "acme/widget", path: "bin.dat" });
    assert.match(bin.text, /Cannot read binary file/);
    const img = await executeFileRead(gh, CWD, { repo: "acme/widget", path: "img.png" });
    assert.equal(img.image?.mimeType, "image/png");
  });
});

describe("pr_view / pr_diff", () => {
  it("pr_view accepts a URL and prefers its repo", async () => {
    const { gh, calls } = fakeGh([
      { match: (a) => a[0] === "pr", respond: () => ({ stdout: JSON.stringify({ number: 9, title: "Add feature", state: "OPEN", files: [{ path: "a.ts", additions: 1, deletions: 0 }] }) }) },
    ]);
    const text = await executePrView(gh, CWD, { pr: "https://github.com/acme/widget/pull/9" });
    assert.match(text, /# Pull Request #9: Add feature/);
    assert.match(text, /a\.ts \[CHANGED\] \(\+1 -0\)/);
    const prArgs = calls.find((a) => a[0] === "pr")!;
    // URL identifier → no competing --repo flag (OMP appendRepoFlag).
    assert.equal(prArgs.includes("--repo"), false);
  });

  it("pr_diff passes through the unified diff", async () => {
    const { gh } = fakeGh([
      { match: (a) => a[0] === "pr", respond: () => ({ stdout: "diff --git a/x b/x\n" }) },
    ]);
    const text = await executePrDiff(gh, CWD, { repo: "acme/widget", pr: "9" });
    assert.match(text, /diff --git a\/x b\/x/);
  });
});

describe("run_watch", () => {
  it("parses run references", () => {
    assert.deepEqual(parseRunReference("12345"), { runId: 12345 });
    // The host is KEPT (OMP parity): a ref that names a host pins the request to it.
    assert.deepEqual(parseRunReference("https://github.com/a/b/actions/runs/77/attempt/1"), { repo: "github.com/a/b", runId: 77 });
    assert.throws(() => parseRunReference("not-a-run"), /numeric workflow run ID/);
  });

  it("tails failed-job logs on failure", async () => {
    const completed = { id: 1, name: "CI", status: "completed", conclusion: "failure", html_url: "https://ci/1" };
    const { gh } = fakeGh([
      { match: (a) => a[0] === "repo" && a[1] === "view", respond: () => ({ stdout: "https://github.com/acme/widget" }) },
      { match: (a) => a.some((x) => String(x).endsWith("/actions/runs/1")), respond: () => ({ stdout: JSON.stringify(completed) }) },
      { match: (a) => a.some((x) => String(x).includes("/actions/runs/1/jobs")), respond: () => ({ stdout: JSON.stringify({ jobs: [{ id: 11, name: "build", status: "completed", conclusion: "failure" }] }) }) },
      { match: (a) => a.some((x) => String(x).includes("/actions/jobs/11/logs")), respond: () => ({ stdout: "l1\nl2\nl3" }) },
    ]);
    const text = await executeRunWatch(gh, CWD, { run: "1", tail: 2 }, undefined, 5_000);
    assert.match(text, /Run failed\./);
    assert.match(text, /l2\nl3/); // tail=2 keeps the last two lines
  });

  it("reports the still-running state when the budget elapses", async () => {
    const inProgress = { id: 2, name: "CI", status: "in_progress", html_url: "https://ci/2" };
    const { gh } = fakeGh([
      { match: (a) => a[0] === "repo" && a[1] === "view", respond: () => ({ stdout: "https://github.com/acme/widget" }) },
      { match: (a) => a.some((x) => String(x).endsWith("/actions/runs/2")), respond: () => ({ stdout: JSON.stringify(inProgress) }) },
      { match: (a) => a.some((x) => String(x).includes("/actions/runs/2/jobs")), respond: () => ({ stdout: JSON.stringify({ jobs: [] }) }) },
    ]);
    const text = await executeRunWatch(gh, CWD, { run: "2" }, undefined, 1);
    assert.match(text, /watch budget elapsed/);
  });

  it("classifies failed jobs and clamps tail", () => {
    assert.equal(isFailedJob({ id: 1, name: "j", conclusion: "failure" }), true);
    assert.equal(isFailedJob({ id: 1, name: "j", conclusion: "success" }), false);
    assert.equal(isFailedJob({ id: 1, name: "j", conclusion: undefined }), false);
    assert.equal(resolveTailLimit(undefined), 15);
    assert.equal(resolveTailLimit(999_999), 200);
    assert.throws(() => resolveTailLimit(0), /positive/);
  });
});

describe("dispatcher + availability", () => {
  it("unknown op throws", async () => {
    const { gh } = fakeGh([]);
    await assert.rejects(() => executeOp("pr_merge", gh, CWD, {}), /Unknown github op/);
  });

  it("ghAvailable returns a boolean without throwing", () => {
    assert.equal(typeof ghAvailable(), "boolean");
  });

  it("formatGhFailure maps auth and checkout failures", () => {
    assert.match(formatGhFailure([], "", "run gh auth login first"), /not authenticated/);
    assert.match(
      formatGhFailure([], "", "fatal: not a git repository"),
      /Pass `repo` explicitly/,
    );
    assert.equal(formatGhFailure(["repo", "view"], "", ""), "GitHub CLI command failed: gh repo view");
    // An explicit repo suppresses the checkout hint.
    assert.equal(
      formatGhFailure(["repo", "view"], "", "fatal: not a git repository", { repoProvided: true } satisfies GhCommandOptions),
      "fatal: not a git repository",
    );
  });
});

describe("/config row (run_watch budget)", () => {
  // Round-trip: the row setter mutates a SHARED { value } object (the
  // todo-module pattern) so the save path persists what was edited — a
  // by-value parameter made the setting silently unwritable (round-3 P2).
  it("row.set writes through to the working copy; garbage input keeps it", async () => {
    const { buildGhGroups } = await import("../configPanel.ts");
    const working = { value: 600 };
    const row0 = buildGhGroups(working)[0]!.rows[0]!;
    assert.equal(row0.key, "gh.runWatchTimeoutSecs");
    assert.equal(row0.value, 600);

    row0.set("900");
    assert.equal(working.value, 900);
    row0.set(1200);
    assert.equal(working.value, 1200);

    // NaN guard: a garbage inline edit leaves the working value untouched
    // (a NaN would JSON-serialize to null and silently reset the setting).
    row0.set("garbage");
    assert.equal(working.value, 1200);
    // Floor: sub-10 values clamp to 10.
    row0.set(5);
    assert.equal(working.value, 10);
  });

  it("save() persists the edited working value and notifies; no owned key = no-op", async () => {
    const { ghConfig } = await import("../configPanel.ts");
    const home = process.env.PI_CODING_AGENT_DIR;
    const dir = mkdtempSync(join(tmpdir(), "gh-config-"));
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      const cfg = ghConfig({} as never);
      // Drive the row the panel drives it: build groups, edit, save.
      const row0 = cfg.groups()[0]!.rows[0]!;
      row0.set("900");

      const notes: string[] = [];
      await cfg.save(new Set(["gh.runWatchTimeoutSecs"]), {
        ui: { notify: (m: string) => notes.push(m) },
      } as never);
      const persisted = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
      assert.equal(persisted.gh.runWatchTimeoutSecs, 900);
      assert.match(notes[0] ?? "", /runWatchTimeoutSecs=900/);

      // No owned edited key → no write.
      await cfg.save(new Set(["other.key"]), {
        ui: { notify: (m: string) => notes.push(m) },
      } as never);
      assert.equal(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).gh.runWatchTimeoutSecs, 900);
      assert.equal(notes.length, 1);
    } finally {
      if (home === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = home;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
