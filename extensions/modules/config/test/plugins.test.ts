/**
 * Plugins group tests — Pi package enable/disable via the `packages` array.
 *
 * Contract under test (Pi's package-manager load rules):
 *   string entry                        → load everything
 *   object, no resource arrays / autoload unset → load everything
 *   object, all four arrays empty       → load NONE  (the off form)
 *   object with patterns / partial []   → filtered (read-only here)
 *   object, autoload: false             → project delta (read-only here)
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_HOME = join(tmpdir(), "ceulen-plugins-test-" + process.pid);
before(() => {
  mkdirSync(TMP_HOME, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = TMP_HOME;
});
after(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});

const settingsPath = () => join(TMP_HOME, "settings.json");

const load = async () => import("../plugins.js");

describe("plugins — state contract", () => {
  it("classifies every entry shape by Pi's load rules", async () => {
    const { packageState } = await load();
    assert.equal(packageState("npm:@a/accordion"), "on");
    assert.equal(packageState({ source: "npm:@a/accordion" }), "on");
    assert.equal(packageState({ source: "npm:@a/accordion", autoload: false }), "filtered");
    assert.equal(
      packageState({ source: "npm:@a/accordion", extensions: [], skills: [], prompts: [], themes: [] }),
      "off",
    );
    // Partial empty arrays / patterns → granular pi-config setup, read-only.
    assert.equal(packageState({ source: "x", extensions: [] }), "filtered");
    assert.equal(packageState({ source: "x", extensions: ["+a.ts", "-b.ts"] }), "filtered");
  });

  it("labels npm, git, and local sources without version noise", async () => {
    const { packageLabel } = await load();
    assert.equal(packageLabel("npm:@a-fig/accordion@1.2.3"), "@a-fig/accordion");
    assert.equal(packageLabel("npm:@a-fig/accordion"), "@a-fig/accordion");
    assert.equal(packageLabel("git:github.com/example/pi-tools@v1"), "pi-tools");
    assert.equal(packageLabel("https://github.com/example/pi-tools.git"), "pi-tools");
    assert.equal(packageLabel("../../../../Volumes/Dev/agents/pi-extensions/pi-a2a"), "pi-a2a");
    assert.equal(packageLabel("/Volumes/Dev/agents/ceulen"), "ceulen");
  });

  it("flips on ⇄ off with the exact forms Pi understands", async () => {
    const { flipPackage, packageState } = await load();
    const off = flipPackage("npm:@a/x", false) as Record<string, unknown>;
    assert.deepEqual(off, { source: "npm:@a/x", extensions: [], skills: [], prompts: [], themes: [] });
    assert.equal(packageState(off), "off");
    assert.equal(flipPackage(off, true), "npm:@a/x");
    // Filtered entries pass through untouched.
    const filtered = { source: "x", extensions: ["+a"] };
    assert.equal(flipPackage(filtered, false), filtered);
  });
});

describe("plugins — read", () => {
  it("reads global + trusted-project entries, project first", async () => {
    writeFileSync(settingsPath(), JSON.stringify({ packages: ["npm:global-one"] }));
    const { readPackageEntries } = await load();
    let entries = readPackageEntries(TMP_HOME); // untrusted cwd → global only
    assert.deepEqual(entries.map((e) => [e.source, e.scope, e.state]), [["npm:global-one", "global", "on"]]);

    // Trust the project cwd, add a project package.
    const project = join(TMP_HOME, "proj");
    mkdirSync(join(project, ".pi"), { recursive: true });
    writeFileSync(join(TMP_HOME, "trust.json"), JSON.stringify({ [project]: true }));
    writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({ packages: ["npm:proj-one"] }));
    entries = readPackageEntries(project);
    assert.deepEqual(entries.map((e) => [e.source, e.scope]), [["npm:proj-one", "project"], ["npm:global-one", "global"]]);
  });

  it("empty install shows the discoverability hint row", async () => {
    writeFileSync(settingsPath(), JSON.stringify({}));
    const { buildPluginsGroups, openPluginsWorking } = await load();
    const groups = buildPluginsGroups(openPluginsWorking(TMP_HOME));
    assert.equal(groups.length, 1, "one hint group when nothing is installed");
    assert.equal(groups[0]!.rows.length, 1);
    assert.equal(groups[0]!.rows[0]!.kind, "info");
    assert.ok(groups[0]!.rows[0]!.description!.includes("pi install"));
  });

  it("toggleable rows expose toggle kind; filtered rows are info/read-only", async () => {
    writeFileSync(settingsPath(), JSON.stringify({
      packages: ["npm:on-one", { source: "npm:off-one", extensions: [], skills: [], prompts: [], themes: [] }, { source: "npm:custom", extensions: ["+x.ts"] }],
    }));
    const { buildPluginsGroups, openPluginsWorking } = await load();
    const rows = buildPluginsGroups(openPluginsWorking(TMP_HOME)).flatMap((g: any) => g.rows);
    assert.deepEqual(rows.map((r) => [r.label, r.kind, r.value]), [
      ["on-one", "toggle", true],
      ["off-one", "toggle", false],
      ["custom", "info", "custom filters"],
    ]);
  });
});

describe("plugins — write", () => {
  it("toggling off writes the all-empty-array form into the file that owns the entry", async () => {
    writeFileSync(settingsPath(), JSON.stringify({ theme: "dark", packages: ["npm:k"] }));
    const { buildPluginsGroups, openPluginsWorking, savePlugins } = await load();
    const working = openPluginsWorking(TMP_HOME);
    const row = buildPluginsGroups(working).flatMap((g: any) => g.rows)[0]!;
    row.set(false);
    const written = savePlugins(working);
    assert.deepEqual(written, [settingsPath()]);
    const json = JSON.parse(readFileSync(settingsPath(), "utf8"));
    assert.equal(json.theme, "dark", "unrelated keys survive");
    assert.deepEqual(json.packages, [{ source: "npm:k", extensions: [], skills: [], prompts: [], themes: [] }]);
  });

  it("toggling back on restores the string form; no-op save writes nothing", async () => {
    writeFileSync(settingsPath(), JSON.stringify({ packages: [{ source: "npm:k", extensions: [], skills: [], prompts: [], themes: [] }] }));
    const { buildPluginsGroups, openPluginsWorking, savePlugins } = await load();
    const working = openPluginsWorking(TMP_HOME);
    assert.deepEqual(savePlugins(openPluginsWorking(TMP_HOME)), [], "no edits → no write");
    const row = buildPluginsGroups(working).flatMap((g: any) => g.rows)[0]!;
    assert.equal(row.value, false);
    row.set(true);
    savePlugins(working);
    assert.deepEqual(JSON.parse(readFileSync(settingsPath(), "utf8")).packages, ["npm:k"]);
  });

  it("project entries write to the project file, global stays untouched", async () => {
    const project = join(TMP_HOME, "proj2");
    mkdirSync(join(project, ".pi"), { recursive: true });
    writeFileSync(join(TMP_HOME, "trust.json"), JSON.stringify({ [project]: true }));
    writeFileSync(settingsPath(), JSON.stringify({ packages: ["npm:g"] }));
    writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({ packages: ["npm:p"] }));
    const { buildPluginsGroups, openPluginsWorking, savePlugins } = await load();
    const working = openPluginsWorking(project);
    const groups = buildPluginsGroups(working);
    // Both scopes share ONE tab; each scope is its own SECTION (sidebar).
    assert.deepEqual(groups.map((g) => [g.tab, g.label]), [["Plugins", "Project"], ["Plugins", "Global"]]);
    const rows = groups.flatMap((g: any) => g.rows);
    assert.deepEqual(rows.map((r) => r.label), ["p", "g"], "project entries first");
    rows[0]!.set(false);
    const written = savePlugins(working);
    assert.deepEqual(written, [join(project, ".pi", "settings.json")]);
    assert.deepEqual(JSON.parse(readFileSync(settingsPath(), "utf8")).packages, ["npm:g"]);
  });

  it("an unreadable settings file degrades to no entries (nothing toggles, nothing writes)", async () => {
    writeFileSync(settingsPath(), '{ "packages": ["npm:k"]\nOOPS');
    const { readPackageEntries, buildPluginsGroups, openPluginsWorking, savePlugins } = await load();
    assert.deepEqual(readPackageEntries(TMP_HOME), [], "corrupt read degrades like readDisabled");
    const working = openPluginsWorking(TMP_HOME);
    const groups = buildPluginsGroups(working);
    assert.equal(groups[0]!.rows[0]!.kind, "info", "hint row, not a broken toggle");
    assert.deepEqual(savePlugins(working), [], "nothing to write — corrupt file untouched");
  });

  it("writePackages refuses a corrupt file (atomicity guard backstop)", async () => {
    const { writePackages } = await load();
    writeFileSync(settingsPath(), '{ "packages": ["npm:k"]\nOOPS');
    const before = readFileSync(settingsPath(), "utf8");
    assert.throws(() => writePackages(settingsPath(), ["npm:k"]), /not valid JSON/);
    assert.equal(readFileSync(settingsPath(), "utf8"), before);
  });

  it("read-only rows cannot be flipped by a stray set()", async () => {
    writeFileSync(settingsPath(), JSON.stringify({ packages: [{ source: "npm:c", extensions: ["+x.ts"] }] }));
    const { buildPluginsGroups, openPluginsWorking, savePlugins } = await load();
    const working = openPluginsWorking(TMP_HOME);
    const row = buildPluginsGroups(working).flatMap((g: any) => g.rows)[0]!;
    row.set(false);
    assert.deepEqual(savePlugins(working), [], "filtered entry unchanged");
    assert.deepEqual(JSON.parse(readFileSync(settingsPath(), "utf8")).packages, [{ source: "npm:c", extensions: ["+x.ts"] }]);
  });
});
