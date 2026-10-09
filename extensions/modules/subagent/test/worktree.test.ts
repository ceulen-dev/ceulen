// Worktree sandbox lifecycle — lock serialization, owner marker, GC sweep,
// CoW clone construction, baseline carry (READ-ONLY on the parent), and
// .worktreeinclude copying. Git state is exercised through a scripted exec
// fake (the module's established seam) so no assertion depends on the host's
// git version; on-disk effects use real temp dirs.

import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  applyBaselineToWorktree,
  captureParentBaseline,
  copyWorktreeIncludes,
  createWorktree,
  pidAlive,
  sweepStaleWorktrees,
  withRepoLock,
  WORKTREE_DIR_NAME,
} from "../lib/runner.ts";

const dirs: string[] = [];
after(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

type Exec = (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Scripted exec: records every (command, args, cwd) and answers from a map of
 *  predicate → response (first match wins). Unmatched git calls succeed empty. */
function fakeExec(handlers: Array<{ match: (command: string, args: string[], cwd?: string) => boolean; code?: number; stdout?: string; stderr?: string }>): Exec & { calls: { command: string; args: string[]; cwd?: string }[] } {
  const calls: { command: string; args: string[]; cwd?: string }[] = [];
  const fn = async (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
    calls.push({ command, args, cwd: options?.cwd });
    const hit = handlers.find((h) => h.match(command, args, options?.cwd));
    if (!hit && command === "git") return { code: 0, stdout: "", stderr: "" };
    if (!hit) return { code: 1, stdout: "", stderr: `unexpected command: ${command} ${args.join(" ")}` };
    return { code: hit.code ?? 0, stdout: hit.stdout ?? "", stderr: hit.stderr ?? "" };
  };
  (fn as Exec & { calls: typeof calls }).calls = calls;
  return fn as Exec & { calls: typeof calls };
}

// ── withRepoLock: serialization + error isolation ──────────────────────────

describe("withRepoLock", () => {
  it("serializes same-repo blocks and releases the key when idle", async () => {
    const order: string[] = [];
    let release1: (() => void) | undefined;
    const gate = new Promise<void>((r) => { release1 = r; });
    const p1 = withRepoLock("/repo", async () => { order.push("a-start"); await gate; order.push("a-end"); });
    const p2 = withRepoLock("/repo", async () => { order.push("b-start"); });
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(order, ["a-start"]); // b must be waiting
    release1!();
    await Promise.all([p1, p2]);
    assert.deepEqual(order, ["a-start", "a-end", "b-start"]);
  });

  it("a failing block does not poison the queue and still propagates to its caller", async () => {
    await assert.rejects(withRepoLock("/repo2", async () => { throw new Error("boom"); }), /boom/);
    const out = await withRepoLock("/repo2", async () => "clean");
    assert.equal(out, "clean");
  });

  it("different repos do not block each other", async () => {
    const order: string[] = [];
    await Promise.all([
      withRepoLock("/repoA", async () => { await new Promise((r) => setTimeout(r, 20)); order.push("A"); }),
      withRepoLock("/repoB", async () => { order.push("B"); }),
    ]);
    assert.deepEqual(order, ["B", "A"]);
  });
});

// ── Owner marker + pid liveness ─────────────────────────────────────────────

describe("owner marker + pid liveness", () => {
  it("pidAlive: current process alive, pid 2^22 dead", () => {
    assert.equal(pidAlive(process.pid), true);
    // A pid that cannot exist on any supported host (max pid < 2^22 everywhere
    // practical; on Linux pid_max default caps at 32768/4194304).
    assert.equal(pidAlive(16 * 1024 * 1024), false);
  });
});

// ── GC sweep decisions ──────────────────────────────────────────────────────

describe("sweepStaleWorktrees", () => {
  it("removes dead-pid and marker-less sandboxes, keeps live ones, uses worktree remove for registered dirs", async () => {
    const repo = await tempDir("wt-sweep-repo-");
    const base = join(repo, WORKTREE_DIR_NAME);
    await mkdir(join(base, "dead"), { recursive: true });
    await mkdir(join(base, "live"), { recursive: true });
    await mkdir(join(base, "legacy"), { recursive: true });
    await writeFile(join(base, "dead.owner.json"), JSON.stringify({ pid: 16 * 1024 * 1024, id: "dead", createdAt: 1 }));
    await writeFile(join(base, "live.owner.json"), JSON.stringify({ pid: process.pid, id: "live", createdAt: Date.now() }));
    const wtList = `worktree ${repo}\nHEAD abc\n\nworktree ${join(base, "dead")}\nHEAD def\n\n`;
    const exec = fakeExec([
      { match: (_c, args) => args[0] === "rev-parse", stdout: `${repo}\n` },
      { match: (_c, args) => args[0] === "worktree" && args[1] === "list", stdout: wtList },
    ]);
    const result = await sweepStaleWorktrees(repo, exec);
    assert.deepEqual(result.removed.map((r) => r.split("/").pop()).sort(), ["dead", "legacy"]);
    assert.equal(result.kept, 1);
    const removeCalls = exec.calls.filter((c) => c.args[0] === "worktree" && c.args[1] === "remove");
    assert.equal(removeCalls.length, 1); // only the registered one via git
    assert.ok(removeCalls[0].args[3].includes("dead"));
    await assert.rejects(stat(join(base, "dead")));
    await assert.rejects(stat(join(base, "legacy")));
    await stat(join(base, "live")); // still there
  });

  it("no .pi-worktrees dir → zero cost, no git calls beyond rev-parse", async () => {
    const repo = await tempDir("wt-sweep-empty-");
    const exec = fakeExec([{ match: (_c, args) => args[0] === "rev-parse", stdout: `${repo}\n` }]);
    const result = await sweepStaleWorktrees(repo, exec);
    assert.deepEqual(result, { removed: [], kept: 0 });
    assert.equal(exec.calls.length, 1);
  });

  it("orphan marker (no matching dir) is reclaimed by the sweep", async () => {
    const repo = await tempDir("wt-sweep-orphan-");
    const base = join(repo, WORKTREE_DIR_NAME);
    await mkdir(base, { recursive: true });
    await writeFile(join(base, "orphan.owner.json"), JSON.stringify({ pid: process.pid, id: "orphan", createdAt: Date.now() }));
    const exec = fakeExec([
      { match: (_c, args) => args[0] === "rev-parse", stdout: `${repo}\n` },
      { match: (_c, args) => args[0] === "worktree" && args[1] === "list", stdout: "" },
    ]);
    const result = await sweepStaleWorktrees(repo, exec);
    assert.deepEqual(result, { removed: [], kept: 0 });
    await assert.rejects(stat(join(base, "orphan.owner.json")), "orphan marker must be dropped");
  });

  it("force: foreign live-pid sandbox removed, non-force keeps it, own pid stays protected", async () => {
    const repo = await tempDir("wt-sweep-force-");
    const base = join(repo, WORKTREE_DIR_NAME);
    await mkdir(join(base, "foreign"), { recursive: true });
    await mkdir(join(base, "mine"), { recursive: true });
    await writeFile(join(base, "foreign.owner.json"), JSON.stringify({ pid: 1, id: "foreign", createdAt: Date.now() }));
    await writeFile(join(base, "mine.owner.json"), JSON.stringify({ pid: process.pid, id: "mine", createdAt: Date.now() }));
    const exec = fakeExec([
      { match: (_c, args) => args[0] === "rev-parse", stdout: `${repo}\n` },
      { match: (_c, args) => args[0] === "worktree" && args[1] === "list", stdout: "" },
    ]);
    const plain = await sweepStaleWorktrees(repo, exec);
    assert.equal(plain.kept, 2); // pid 1 (launchd/init) is alive — the false-KEEP
    await stat(join(base, "foreign"));

    const forced = await sweepStaleWorktrees(repo, exec, { force: true });
    assert.deepEqual(forced.removed.map((r) => r.split("/").pop()), ["foreign"]);
    assert.equal(forced.kept, 1);
    await assert.rejects(stat(join(base, "foreign")));
    await stat(join(base, "mine")); // this process's own live sandbox survives force
  });
});

// ── Baseline capture: PURE READS on the parent ─────────────────────────────

describe("captureParentBaseline", () => {
  it("composes staged + unstaged + untracked diffs; ZERO parent-mutating git args", async () => {
    const repo = "/fake/repo";
    const exec = fakeExec([
      { match: (_c, args) => args[0] === "diff" && args.includes("--cached"), stdout: "STAGED-PATCH\n" },
      { match: (_c, args) => args[0] === "diff" && args.includes("--no-index"), stdout: "UNTRACKED-PATCH\n" },
      { match: (_c, args) => args[0] === "diff", stdout: "UNSTAGED-PATCH\n" },
      { match: (_c, args) => args[0] === "ls-files", stdout: "new1.txt\nnew2.txt\n" },
    ]);
    const result = await captureParentBaseline(repo, exec);
    assert.ok(result.ok);
    // Order mirrors working-tree construction: staged, unstaged, untracked.
    assert.equal(result.patch, "STAGED-PATCH\n\nUNSTAGED-PATCH\n\nUNTRACKED-PATCH\n\nUNTRACKED-PATCH\n");
    const mutators = exec.calls.filter((c) =>
      c.args.includes("add") || c.args.includes("stash") || c.args.includes("commit") || c.args.includes("apply"));
    assert.deepEqual(mutators, []); // parent purity — the advisor-reviewed invariant
    // Untracked diffs are new-file no-index diffs against /dev/null.
    const noIndex = exec.calls.filter((c) => c.args.includes("--no-index"));
    assert.equal(noIndex.length, 2);
    assert.deepEqual(noIndex[0].args.slice(-2), ["/dev/null", "new1.txt"]);
  });

  it("256 MiB budget: oversized baseline is skipped with an error, not buffered", async () => {
    const repo = "/fake/repo2";
    const big = "x".repeat(300 * 1024 * 1024);
    const exec = fakeExec([
      { match: (_c, args) => args[0] === "diff" && args.includes("--cached"), stdout: big },
      { match: (_c, args) => args[0] === "diff" && !args.includes("--cached"), stdout: "" },
      { match: (_c, args) => args[0] === "ls-files", stdout: "" },
    ]);
    const result = await captureParentBaseline(repo, exec);
    assert.equal(result.ok, false);
    assert.match(result.error!, /budget/);
  });
});

// ── Baseline apply: runs INSIDE the worktree cwd ────────────────────────────

describe("applyBaselineToWorktree", () => {
  it("writes the patch to a temp file and applies it in the worktree cwd", async () => {
    let seen: { args: string[]; cwd?: string } | undefined;
    const exec = fakeExec([]);
    const orig = exec;
    const wrapped: Exec = async (command, args, options) => {
      if (command === "git" && args[0] === "apply") seen = { args, cwd: options?.cwd };
      return orig(command, args, options);
    };
    const result = await applyBaselineToWorktree("/wt/dir", "PATCH\n", wrapped);
    assert.ok(result.ok);
    assert.equal(seen!.cwd, "/wt/dir");
    assert.deepEqual(seen!.args.slice(0, 3), ["apply", "--binary", "--whitespace=nowarn"]);
  });

  it("apply failure surfaces the error (caller skips carry)", async () => {
    const exec = fakeExec([{ match: (_c, args) => args[0] === "apply", code: 1, stderr: "error: patch does not apply" }]);
    const result = await applyBaselineToWorktree("/wt/dir", "PATCH\n", exec);
    assert.equal(result.ok, false);
    assert.match(result.error!, /does not apply/);
  });
});

// ── .worktreeinclude ────────────────────────────────────────────────────────

describe("copyWorktreeIncludes", () => {
  it("copies gitignored files matching the include globs into the worktree", async () => {
    const repo = await tempDir("wt-include-repo-");
    const wt = await tempDir("wt-include-dst-");
    await writeFile(join(repo, ".worktreeinclude"), "# env and config\n.env\nconfig/*.local\n");
    await mkdir(join(repo, "config"), { recursive: true });
    await writeFile(join(repo, ".env"), "SECRET=1\n");
    await writeFile(join(repo, "config", "dev.local"), "x=1\n");
    await writeFile(join(repo, "config", "keep.txt"), "not matched\n");
    const exec = fakeExec([{ match: (_c, args) => args[0] === "ls-files", stdout: ".env\nconfig/dev.local\nconfig/keep.txt\n" }]);
    const copied = await copyWorktreeIncludes(repo, wt, exec);
    assert.equal(copied, 2);
    assert.equal(await readFile(join(wt, ".env"), "utf8"), "SECRET=1\n");
    assert.equal(await readFile(join(wt, "config", "dev.local"), "utf8"), "x=1\n");
    await assert.rejects(stat(join(wt, "config", "keep.txt"))); // not gitignored-matched
  });

  it("no .worktreeinclude → no git calls, returns 0", async () => {
    const repo = await tempDir("wt-include-none-");
    const exec = fakeExec([]);
    assert.equal(await copyWorktreeIncludes(repo, "/wt", exec), 0);
    assert.equal(exec.calls.length, 0);
  });
});

// ── createWorktree: CoW construction + fallback ─────────────────────────────

describe("createWorktree", () => {
  it("not-a-repo fails cleanly", async () => {
    const dir = await tempDir("wt-create-norepo-");
    const exec = fakeExec([{ match: (_c, args) => args[0] === "rev-parse", code: 128, stderr: "not a git repository" }]);
    const result = await createWorktree(dir, exec);
    assert.equal(result.ok, false);
    assert.match(result.error!, /not a git repo/);
  });

  it("owner marker exists at the moment `worktree add` runs (git fallback path)", async () => {
    const repo = await tempDir("wt-marker-add-");
    await mkdir(join(repo, ".git"), { recursive: true });
    const base = join(repo, WORKTREE_DIR_NAME);
    let sawMarker: boolean | undefined;
    const exec = fakeExec([
      { match: (_c, args) => args[0] === "rev-parse", stdout: `${repo}\n` },
      { match: (c) => c === "cp", code: 1, stderr: "cp failed" }, // force the git-worktree fallback
    ]);
    const wrapped: Exec = async (command, args, options) => {
      if (command === "git" && args[0] === "worktree" && args[1] === "add") {
        sawMarker = readdirSync(base).some((f) => f.endsWith(".owner.json"));
      }
      return exec(command, args, options);
    };
    const result = await createWorktree(repo, wrapped);
    assert.equal(result.ok, true);
    assert.equal(result.cow, false);
    assert.equal(sawMarker, true, "marker must exist before the sandbox is registered");
  });

  it("marker-write failure → createWorktree fails; never ok without a marker", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root ignores dir perms
    const repo = await tempDir("wt-marker-eacces-");
    await mkdir(join(repo, ".git"), { recursive: true });
    const base = join(repo, WORKTREE_DIR_NAME);
    await mkdir(base, { recursive: true });
    await writeFile(join(base, ".gitignore"), "*\n"); // the gitignore check passes; the MARKER write is what fails
    await chmod(base, 0o500);
    try {
      const exec = fakeExec([{ match: (_c, args) => args[0] === "rev-parse", stdout: `${repo}\n` }]);
      const result = await createWorktree(repo, exec);
      assert.equal(result.ok, false);
      assert.match(result.error!, /marker/);
      assert.ok(!exec.calls.some((c) => c.command === "git" && c.args[0] === "worktree"), "no sandbox registered");
    } finally {
      await chmod(base, 0o700);
    }
  });

  it("a rejecting `worktree add` after the marker write → ok:false AND no orphan marker", async () => {
    const repo = await tempDir("wt-add-throws-");
    await mkdir(join(repo, ".git"), { recursive: true });
    const base = join(repo, WORKTREE_DIR_NAME);
    const exec = fakeExec([
      { match: (_c, args) => args[0] === "rev-parse", stdout: `${repo}\n` },
      { match: (c) => c === "cp", code: 1, stderr: "cp failed" }, // force the git-worktree fallback
    ]);
    const wrapped: Exec = async (command, args, options) => {
      if (command === "git" && args[0] === "worktree" && args[1] === "add") throw new Error("worktree add exploded");
      return exec(command, args, options);
    };
    const result = await createWorktree(repo, wrapped);
    assert.equal(result.ok, false);
    assert.match(result.error!, /exploded/);
    const leftovers = (await readdir(base).catch(() => [] as string[])).filter((f) => f.endsWith(".owner.json"));
    assert.deepEqual(leftovers, [], "no orphan marker may survive a failed creation");
  });

  it("CoW copies the live .git under the repo lock (no torn copy)", { skip: process.platform !== "darwin" }, async () => {
    const repo = await tempDir("wt-cow-lock-");
    await mkdir(join(repo, ".git"), { recursive: true });
    await writeFile(join(repo, "file.txt"), "x");
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const holder = withRepoLock(repo, async () => { order.push("lock-start"); await gate; order.push("lock-end"); });
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(order, ["lock-start"], "holder acquired the lock first");
    const exec = fakeExec([
      { match: (_c, args) => args[0] === "rev-parse", stdout: `${repo}\n` },
      { match: (c) => c === "cp" },
    ]);
    const wrapped: Exec = async (command, args, options) => {
      if (command === "cp" && args[1]?.endsWith("/.git")) order.push("cow-git");
      return exec(command, args, options);
    };
    const pending = createWorktree(repo, wrapped);
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(!order.includes("cow-git"), "cp .git waits for the lock");
    release();
    await holder;
    const result = await pending;
    assert.ok(result.ok, result.error);
    assert.equal(result.cow, undefined, "CoW path ran");
    assert.deepEqual(order, ["lock-start", "lock-end", "cow-git"]);
  });

  it("base .gitignore as a DIRECTORY → createWorktree fails loudly", async () => {
    const repo = await tempDir("wt-gitignore-dir-");
    await mkdir(join(repo, ".git"), { recursive: true });
    await mkdir(join(repo, WORKTREE_DIR_NAME, ".gitignore"), { recursive: true });
    const exec = fakeExec([{ match: (_c, args) => args[0] === "rev-parse", stdout: `${repo}\n` }]);
    const result = await createWorktree(repo, exec);
    assert.equal(result.ok, false);
    assert.match(result.error!, /\.gitignore/);
    assert.ok(!exec.calls.some((c) => c.command === "cp" || c.args[0] === "worktree"), "no sandbox materialized");
  });
});

// ── Sweep: registry stays consistent when `worktree remove` fails ───────────

describe("sweepStaleWorktrees — prune fallback", () => {
  it("a registered dir whose `worktree remove` exits 1 gets `worktree prune`", async () => {
    const repo = await tempDir("wt-sweep-prune-");
    const base = join(repo, WORKTREE_DIR_NAME);
    await mkdir(join(base, "stuck"), { recursive: true });
    const exec = fakeExec([
      { match: (_c, args) => args[0] === "rev-parse", stdout: `${repo}\n` },
      { match: (_c, args) => args[0] === "worktree" && args[1] === "list", stdout: `worktree ${join(base, "stuck")}\n` },
      { match: (_c, args) => args[0] === "worktree" && args[1] === "remove", code: 1, stderr: "remove failed" },
    ]);
    const result = await sweepStaleWorktrees(repo, exec);
    assert.deepEqual(result.removed.map((r) => r.split("/").pop()), ["stuck"]);
    assert.ok(exec.calls.some((c) => c.args[0] === "worktree" && c.args[1] === "prune"), "prune issued after failed remove");
    await assert.rejects(stat(join(base, "stuck"))); // the dir is still gone
  });
});
