// Security-review 2026-10-17 (F6/F12): settings.json may hold a2a tokens and
// history carries task text — both writes must land at 0600, and the history
// rewrite must be atomic (tmp+rename, crash cannot truncate).
import assert from "node:assert/strict";
import { mkdtempSync, statSync, rmSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { writeSubagentSection } from "../lib/settings.js";
import { writeHistory, readHistory, getHistoryPath, type HistoryEntry } from "../lib/history.js";

const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
const dir = mkdtempSync(join(tmpdir(), "subagent-modes-"));
process.env.PI_CODING_AGENT_DIR = dir;

afterEach(() => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
});

describe("subagent write modes (F6/F12)", () => {
  it("writeSubagentSection keeps settings.json at 0600", () => {
    const file = join(dir, "settings.json");
    writeSubagentSection({ idleTimeoutMins: 5 });
    assert.equal(existsSync(file), true);
    assert.equal(statSync(file).mode & 0o777, 0o600, "settings.json must be 0600");
  });

  it("writeHistory is 0600 and atomic (no tmp litter, content intact)", () => {
    const piDir = join(dir, "hist");
    mkdirSync(piDir, { recursive: true });
    const entries = [{ id: "t1", agent: "scout", task: "probe", status: "done" } as unknown as HistoryEntry];
    writeHistory(piDir, entries);
    const file = getHistoryPath(piDir);
    assert.equal(statSync(file).mode & 0o777, 0o600, "history must be 0600");
    assert.deepEqual(readHistory(piDir).map((e) => e.id), ["t1"], "content survives the rename");
    const litter = readdirSync(piDir).filter((f) => f.includes(".tmp-"));
    assert.deepEqual(litter, [], "rename left no tmp litter");
  });
});
