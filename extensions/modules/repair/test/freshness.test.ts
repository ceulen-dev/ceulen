// Multi-session safety in the repair module: the write freshness guard
// (read→foreign-write→write must fail loud) and the auto conflict-marker
// footer on full-file reads. Real temp files, real wrapped tool definitions —
// the wrapper.test.ts integration precedent.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createEditToolDefinition, createReadToolDefinition, createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import { appendConflictFooter, checkWriteFresh, wrapToolDefinition } from "../index.js";

const dirs: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "repair-freshness-"));
  dirs.push(dir);
  process.env.PI_CODING_AGENT_DIR = dir;
  return dir;
}

// Minimal wrapToolDefinition harness — the real core definitions, no repair
// toggles needed (defaults off for arguments; freshness/footer are always-on).
function makeWrapped(name: "read" | "write", cwd: string) {
  const factory = name === "read" ? createReadToolDefinition : createWriteToolDefinition;
  return wrapToolDefinition(factory(cwd), factory, () => false, () => {});
}

const exec = (wrapped: any, params: any, cwd: string) =>
  wrapped.execute("t1", params, undefined, undefined, { cwd });

// ── Write freshness guard ───────────────────────────────────────────────────

describe("write freshness guard", () => {
  it("write after read, no foreign change → succeeds and content lands", async () => {
    const dir = await tempDir();
    const file = join(dir, "a.txt");
    await writeFile(file, "one\n");
    const read = makeWrapped("read", dir);
    await exec(read, { path: file }, dir);
    const write = makeWrapped("write", dir);
    const result = await exec(write, { path: file, content: "one\ntwo\n" }, dir);
    assert.equal(result.isError, undefined);
    assert.equal(await readFile(file, "utf8"), "one\ntwo\n");
  });

  it("read → FOREIGN write → write fails loud without clobbering", async () => {
    const dir = await tempDir();
    const file = join(dir, "b.txt");
    await writeFile(file, "mine\n");
    const read = makeWrapped("read", dir);
    await exec(read, { path: file }, dir);
    // Another session/process writes the file between our read and write.
    await writeFile(file, "theirs\n");
    // Ensure mtime actually advances (same-ms writes would false-pass).
    const st = await readFile(file, "utf8");
    const future = new Date(Date.now() + 1100);
    await utimes(file, future, future);
    assert.equal(st, "theirs\n");
    const write = makeWrapped("write", dir);
    const result = await exec(write, { path: file, content: "mine v2\n" }, dir);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Re-read the file/);
    assert.equal(await readFile(file, "utf8"), "theirs\n"); // foreign edit survived
  });

  it("write after own edit does not false-positive", async () => {
    const dir = await tempDir();
    const file = join(dir, "c.txt");
    await writeFile(file, "x\n");
    const read = makeWrapped("read", dir);
    await exec(read, { path: file }, dir);
    const write = makeWrapped("write", dir);
    await exec(write, { path: file, content: "y\n" }, dir);
    const again = await exec(write, { path: file, content: "z\n" }, dir);
    assert.equal(again.isError, undefined);
    assert.equal(await readFile(file, "utf8"), "z\n");
  });

  it("write to a never-read file is allowed (intentional overwrite is legal)", async () => {
    const dir = await tempDir();
    const file = join(dir, "d.txt");
    await writeFile(file, "old\n");
    const write = makeWrapped("write", dir);
    const result = await exec(write, { path: file, content: "new\n" }, dir);
    assert.equal(result.isError, undefined);
  });

  it("write after own apply_patch does not false-positive", async () => {
    const dir = await tempDir();
    const file = join(dir, "e.txt");
    await writeFile(file, "alpha\n");
    const read = makeWrapped("read", dir);
    await exec(read, { path: file }, dir);
    // Simulate the apply_patch flow: patch tool mutates (externally to the
    // wrapped write), refreshes the baseline, then a write must pass.
    await writeFile(file, "alpha\nbeta\n");
    const future = new Date(Date.now() + 1100);
    await utimes(file, future, future);
    const { refreshMtime } = await import("../index.js");
    await refreshMtime(file, dir);
    const write = makeWrapped("write", dir);
    const result = await exec(write, { path: file, content: "alpha\nbeta\ngamma\n" }, dir);
    assert.equal(result.isError, undefined);
  });

  it("checkWriteFresh unit: missing file since read is allowed (recreate)", async () => {
    const dir = await tempDir();
    const file = join(dir, "gone.txt");
    await writeFile(file, "x\n");
    const read = makeWrapped("read", dir);
    await exec(read, { path: file }, dir);
    await rm(file);
    assert.equal(await checkWriteFresh({ path: file }, dir), undefined);
  });

  it("a SELECTOR read records the freshness baseline (ranged reads don't blind the guard)", async () => {
    // Live finding (reviewer 2026-10-06): the selector slice path returned
    // early without recordReadMtimes, so read f.ts:5-10 → foreign write →
    // blind full-file write silently clobbered the foreign edit.
    const dir = await tempDir();
    const file = join(dir, "sel.txt");
    await writeFile(file, "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n");
    const read = wrapToolDefinition(createReadToolDefinition(dir), createReadToolDefinition, () => false, () => {});
    const sliced = await exec(read, { path: `${file}:2-4` }, dir);
    assert.equal(sliced.isError, undefined);
    // Foreign edit + mtime bump after our ranged read.
    await writeFile(file, "FOREIGN\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n");
    const future = new Date(Date.now() + 1100);
    await utimes(file, future, future);
    const write = makeWrapped("write", dir);
    const result = await exec(write, { path: file, content: "mine\n" }, dir);
    assert.equal(result.isError, true, "selector read must arm the freshness guard");
    assert.match(result.content[0].text, /Re-read the file/);
    assert.match(await readFile(file, "utf8"), /FOREIGN/);
  });

  it("a special-view read records the STEM's baseline (db.sqlite:users arms the guard)", async () => {
    // F6: the raw selector path (db.sqlite:users) was recorded instead of the
    // stem — no mtime ever landed, so a foreign write to the db after the read
    // was invisible to the freshness guard.
    const { DatabaseSync } = await import("node:sqlite");
    const dir = await tempDir();
    const dbFile = join(dir, "db.sqlite");
    const db = new DatabaseSync(dbFile);
    db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");
    db.exec("INSERT INTO users (name) VALUES ('alice')");
    db.close();

    const read = makeWrapped("read", dir);
    const result = await exec(read, { path: "db.sqlite:users" }, dir);
    assert.match(String(result.content[0].text), /alice/, "special view served");

    // Foreign write (fresh mtime) after our read → a full-file write must
    // now be refused, proving the STEM mtime is recorded.
    const db2 = new DatabaseSync(dbFile);
    db2.exec("INSERT INTO users (name) VALUES ('bob')");
    db2.close();
    const future = new Date(Date.now() + 1100);
    await utimes(dbFile, future, future);

    const write = makeWrapped("write", dir);
    const fresh = await exec(write, { path: "db.sqlite", content: "clobber" }, dir);
    assert.equal(fresh.isError, true, "checkWriteFresh sees the recorded stem mtime");
    assert.match(fresh.content[0].text, /Re-read the file/);
  });

  it("write after a wrapped EDIT does not false-positive (edit refreshes the baseline)", async () => {
    // Live-found defect (reviewer 2026-10-06): a successful edit never
    // refreshed the freshness baseline, so read → edit → write compared the
    // write against the stale READ-time mtime and blocked with a false
    // "File changed on disk" — recordMutatedMtimes' edit branch was dead code.
    const dir = await tempDir();
    const file = join(dir, "edit-baseline.txt");
    await writeFile(file, "alpha\n");
    const read = wrapToolDefinition(createReadToolDefinition(dir), createReadToolDefinition, () => false, () => {});
    await exec(read, { path: file }, dir);
    const edit = wrapToolDefinition(createEditToolDefinition(dir), createEditToolDefinition, () => false, () => {});
    const edited = await exec(edit, { path: file, edits: [{ oldText: "alpha", newText: "alpha\nbeta" }] }, dir);
    assert.equal(edited.isError, undefined, "edit succeeded");
    const write = makeWrapped("write", dir);
    const result = await exec(write, { path: file, content: "alpha\nbeta\ngamma\n" }, dir);
    assert.equal(result.isError, undefined, "write after own edit must pass the freshness guard");
    assert.equal(await readFile(file, "utf8"), "alpha\nbeta\ngamma\n");
  });
});

// ── Conflict-marker footer ──────────────────────────────────────────────────

describe("conflict footer", () => {
  it("pure function: appends footer when completed blocks present", () => {
    const content = "a\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\nb\n";
    const result = appendConflictFooter(
      { content: [{ type: "text", text: content }] },
      { path: "f.txt" },
      undefined,
      "/cwd",
    );
    const footer = result.content[result.content.length - 1];
    assert.match(footer.text, /1 unresolved merge conflict block/);
    assert.match(footer.text, /first at line 2/);
  });

  it("pure function: silent without conflicts, and open (unclosed) markers don't count", () => {
    const clean = appendConflictFooter({ content: [{ type: "text", text: "no markers\n" }] }, { path: "f.txt" }, undefined, "/c");
    assert.equal(clean.content.length, 1);
    const open = appendConflictFooter({ content: [{ type: "text", text: "<<<<<<< HEAD\nnever closed\n" }] }, { path: "f.txt" }, undefined, "/c");
    assert.equal(open.content.length, 1);
  });

  it("selector reads are excluded (the :conflicts path lists blocks explicitly)", () => {
    const content = "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> b\n";
    const result = appendConflictFooter(
      { content: [{ type: "text", text: content }] },
      { path: "f.txt" },
      { kind: "lines", startLine: 1 } as never,
      "/c",
    );
    assert.equal(result.content.length, 1);
  });

  it("integration: wrapped read of a conflicted file carries the footer", async () => {
    const dir = await tempDir();
    const file = join(dir, "conflicted.txt");
    await writeFile(file, "top\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> other\nbottom\n");
    const read = makeWrapped("read", dir);
    const result = await exec(read, { path: file }, dir);
    const texts = result.content.map((c: any) => c.text).join("\n");
    assert.match(texts, /1 unresolved merge conflict block/);
  });
});
