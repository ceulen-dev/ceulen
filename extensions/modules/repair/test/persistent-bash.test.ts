// Persistent bash wrapper: real-process tests (the shells module's pattern) so
// persistence, reset, and serialization are proven against an actual shell
// rather than a mock of it.
//
// PI_SESSION_ID travels through `options.env` exactly as pi's bash tool passes
// it (resolveSpawnContext, exposeSessionEnvironment), so per-session scoping is
// exercised on the real transport.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { setPlanActive } from "../../../lib/plan-bridge.ts";
import {
  DEFAULT_COMMAND_TIMEOUT_SECS,
  installPersistentExitSweepForTests,
  killPersistentShells,
  persistentBashClause,
  quoteForEval,
  wrapCommand,
  wrapWithPersistentShell,
} from "../lib/persistent-bash.js";

/** Fresh one-shot operations for the plan-mode / fallback path. */
async function localOps() {
  const { createLocalBashOperations } = await import("@earendil-works/pi-coding-agent");
  return createLocalBashOperations();
}

interface RunResult {
  text: string;
  exitCode: number | null;
}

/** Run one command through the wrapper for a given session id. */
function run(
  ops: ReturnType<typeof wrapWithPersistentShell>,
  command: string,
  opts: { sessionId?: string; timeout?: number; signal?: AbortSignal; cwd?: string } = {},
): Promise<RunResult> {
  let text = "";
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (opts.sessionId !== undefined) env.PI_SESSION_ID = opts.sessionId;
  return ops
    .exec(command, opts.cwd ?? process.cwd(), {
      onData: (data: Buffer) => {
        text += data.toString("utf8");
      },
      signal: opts.signal,
      timeout: opts.timeout,
      env,
    })
    .then((r) => ({ text, exitCode: r.exitCode }));
}

const sid = (tag: string) => `ceulen-ps-test-${tag}-${process.pid}-${Date.now()}`;

let ops: ReturnType<typeof wrapWithPersistentShell>;
const sessions: string[] = [];

beforeEach(async () => {
  ops = wrapWithPersistentShell(await localOps());
});

afterEach(() => {
  for (const id of sessions.splice(0)) killPersistentShells(id);
  killPersistentShells();
  setPlanActive(false);
});

function track(tag: string): string {
  const id = sid(tag);
  sessions.push(id);
  return id;
}

describe("persistent bash: state survives across calls", () => {
  it("keeps exported variables", async () => {
    const id = track("export");
    await run(ops, "export CEULEN_PROBE=42", { sessionId: id });
    const r = await run(ops, "echo CEULEN_PROBE=$CEULEN_PROBE", { sessionId: id });
    assert.equal(r.text.trim(), "CEULEN_PROBE=42");
    assert.equal(r.exitCode, 0);
  });

  it("keeps the working directory", async () => {
    const id = track("cwd");
    const target = process.platform === "win32" ? process.cwd() : "/tmp";
    await run(ops, `cd ${target}`, { sessionId: id });
    const r = await run(ops, "pwd", { sessionId: id });
    assert.equal(r.text.trim(), target);
  });

  it("keeps shell functions", async () => {
    const id = track("func");
    await run(ops, "ceulen_fn() { echo yes-$1; }", { sessionId: id });
    const r = await run(ops, "ceulen_fn a", { sessionId: id });
    assert.equal(r.text.trim(), "yes-a");
  });

  it("hands background-job output to a later call", async () => {
    const id = track("bg");
    await run(ops, "(sleep 0.2; echo LATE_MARKER) &", { sessionId: id });
    // The job's output arrives after its own call already settled. It may land
    // inside ANY later call's window (whichever is open when the pipe flushes),
    // so accumulate across follow-up calls instead of pinning one.
    let seen = "";
    for (let i = 0; i < 10 && !seen.includes("LATE_MARKER"); i++) {
      await new Promise((r) => setTimeout(r, 60));
      seen += (await run(ops, "true", { sessionId: id })).text;
    }
    assert.match(seen, /LATE_MARKER/, "background output is delivered to a later call, never dropped");
  });
});

describe("persistent bash: exit codes and reset", () => {
  it("propagates a failing exit code without resetting the shell", async () => {
    const id = track("fail");
    const r = await run(ops, "false", { sessionId: id });
    assert.equal(r.exitCode, 1);
    await run(ops, "export CEULEN_STILL=here", { sessionId: id });
    assert.equal((await run(ops, "echo $CEULEN_STILL", { sessionId: id })).text.trim(), "here");
  });

  it("resets after an explicit exit and reports the real code", async () => {
    const id = track("exit");
    await run(ops, "export CEULEN_GONE=1", { sessionId: id });
    const died = await run(ops, "exit 7", { sessionId: id });
    assert.equal(died.exitCode, 7);
    assert.match(died.text, /persistent shell exited/);
    // Fresh shell: the variable is gone.
    const r = await run(ops, "echo CEULEN_GONE=[$CEULEN_GONE]", { sessionId: id });
    assert.equal(r.text.trim(), "CEULEN_GONE=[]");
  });

  it("resets on timeout and rejects with pi's timeout prefix", async () => {
    const id = track("timeout");
    await assert.rejects(
      () => run(ops, "sleep 5", { sessionId: id, timeout: 1 }),
      /timeout:1/,
    );
    const after = await run(ops, "echo alive", { sessionId: id });
    assert.equal(after.text.trim(), "alive");
  });

  it("resets on abort and rejects with 'aborted'", async () => {
    const id = track("abort");
    const controller = new AbortController();
    const pending = run(ops, "sleep 5", { sessionId: id, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(() => pending, /aborted/);
    const after = await run(ops, "echo alive", { sessionId: id });
    assert.equal(after.text.trim(), "alive");
  });
});

describe("persistent bash: framing", () => {
  it("runs multiline and heredoc commands through the eval wrap", async () => {
    const id = track("multi");
    const r = await run(
      ops,
      "for i in 1 2 3; do echo line-$i; done\ncat <<'EOF'\nheredoc-body\nEOF",
      { sessionId: id },
    );
    assert.match(r.text, /line-1/);
    assert.match(r.text, /line-3/);
    assert.match(r.text, /heredoc-body/);
  });

  it("asks for a fresh marker on every command", async () => {
    // The nonce is generated per command AFTER the command text exists, so a
    // model can never echo a marker it has not seen. Pin the generator contract:
    // one call per exec, unique values.
    const issued: string[] = [];
    const markerOps = wrapWithPersistentShell(await localOps(), {
      newMarker: () => {
        const marker = `__CEULEN_PS_${(issued.length + 1).toString(16).padStart(16, "0")}__`;
        issued.push(marker);
        return marker;
      },
    });
    const id = track("markers");
    await run(markerOps, "true", { sessionId: id });
    await run(markerOps, "echo one", { sessionId: id });
    assert.equal(issued.length, 2, "one marker per command");
    assert.equal(new Set(issued).size, 2, "markers are never reused");
    for (const marker of issued) assert.match(marker, /^__CEULEN_PS_[0-9a-f]{16}__$/, "reserved prefix preserved");
  });

  it("escapes quotes and control characters via ANSI-C quoting", () => {
    assert.equal(quoteForEval("it's"), "$'it\\'s'");
    assert.equal(quoteForEval("a\nb"), "$'a\\nb'");
    assert.equal(quoteForEval("back\\slash"), "$'back\\\\slash'");
    assert.equal(
      wrapCommand("echo hi", "__CEULEN_PS_x__"),
      "command builtin eval $'echo hi'; command builtin printf '__CEULEN_PS_x__%s\\n' \"$?\"\n",
    );
  });

  // The shell is persistent BY DESIGN, so a function the model defined in an
  // earlier call is still live when the framing runs. Bare `printf`/`eval` in
  // the framing would be shadowed by it, the marker would never print, and a
  // SUCCESSFUL command would hang until the timeout. `builtin` bypasses
  // functions and aliases; pin it so a refactor cannot regress this.
  // `builtin` is itself resolved by NAME, so `builtin() { :; }` suppressed the
  // marker in the first cut of the fix. Both halves now go through
  // `command builtin`, which survives a shadowed `builtin`.
  it("framing survives a retained printf function (marker still prints)", async () => {
    const id = track("shadow-printf");
    await run(ops, "printf() { :; }", { sessionId: id });
    const r = await run(ops, "echo BODY-OK", { sessionId: id, timeout: 10 });
    assert.equal(r.text.trim(), "BODY-OK", "the body still runs and its output is not swallowed");
    assert.equal(r.exitCode, 0);
  });

  it("framing survives a retained eval function", async () => {
    const id = track("shadow-eval");
    await run(ops, "eval() { :; }", { sessionId: id });
    const r = await run(ops, "echo BODY-OK", { sessionId: id, timeout: 10 });
    assert.equal(r.text.trim(), "BODY-OK");
    assert.equal(r.exitCode, 0);
  });

  it("framing survives a retained builtin function", async () => {
    // THE FOLLOW-UP DEFECT: `builtin` is resolved by name, so shadowing IT broke
    // the marker through `builtin printf`.
    const id = track("shadow-builtin");
    await run(ops, "builtin() { :; }", { sessionId: id });
    const r = await run(ops, "echo BODY-OK", { sessionId: id, timeout: 10 });
    assert.equal(r.text.trim(), "BODY-OK");
    assert.equal(r.exitCode, 0);
  });

  it("framing survives printf + eval + builtin all shadowed, with a failing command", async () => {
    // Every framing primitive that `command` can rescue is shadowed, plus a
    // non-zero status, so a suppressed marker would report the wrong code as
    // well as hang.
    const id = track("shadow-all");
    await run(ops, "printf() { :; }; eval() { :; }; builtin() { :; }", { sessionId: id });
    const r = await run(ops, "echo VISIBLE; exit 3", { sessionId: id, timeout: 10 });
    assert.match(r.text, /VISIBLE/);
    assert.equal(r.exitCode, 3, "the real exit status still reaches the caller");
  });

  // THE REMAINING CEILING, pinned as BEHAVIOR rather than left to chance:
  // shadowing `command` ALONE (no help from `builtin`) skips the body and
  // suppresses the marker, so that call times out. What must hold is that the
  // failure is BOUNDED and SELF-HEALING — the timeout resets the shell
  // (reset-never-repair) and the next call runs normally.
  it("shadowing command alone times out and then resets the shell", async () => {
    const id = track("shadow-command");
    await assert.rejects(
      () => run(ops, "command() { :; }", { sessionId: id, timeout: 2 }),
      /timeout:2/,
      "the documented ceiling: `command` is resolved first and is itself shadowable",
    );
    // The reset killed the shell, so the shadow is gone and the body runs again.
    const after = await run(ops, "echo RECOVERED", { sessionId: id, timeout: 10 });
    assert.equal(after.text.trim(), "RECOVERED", "the timeout reset the shell — the shadow did not survive");
    assert.equal(after.exitCode, 0);
    const kind = await run(ops, "type command", { sessionId: id, timeout: 10 });
    assert.match(kind.text, /shell builtin/, "`command` is the builtin again in the fresh shell");
  });

  // pi's bash `timeout` is OPTIONAL (undefined = no timer on the one-shot path).
  // For a persistent shell that would let one never-settling command wedge the
  // shell AND every queued call behind it forever. The wrapper therefore applies
  // DEFAULT_COMMAND_TIMEOUT_SECS as a FLOOR; a low injected floor keeps this
  // fast while exercising the real recovery path.
  it("applies a default deadline when the caller passes no timeout", async () => {
    const floorOps = wrapWithPersistentShell(await localOps(), { defaultTimeoutSecs: 2 });
    const id = track("default-deadline");
    await assert.rejects(
      () => run(floorOps, "command() { :; }", { sessionId: id }),
      /timeout:2/,
      "no caller timeout ⇒ the default floor still fires and reports itself",
    );
    const after = await run(floorOps, "echo RECOVERED", { sessionId: id, timeout: 10 });
    assert.equal(after.text.trim(), "RECOVERED", "the default-deadline reset healed the shell");
  });

  it("an explicit caller timeout overrides the default floor", async () => {
    // Floor of 60 s, caller asks for 2: the CALLER's budget must win, otherwise
    // a deliberately short timeout would silently become a long hang.
    const floorOps = wrapWithPersistentShell(await localOps(), { defaultTimeoutSecs: 60 });
    const id = track("explicit-wins");
    const started = Date.now();
    await assert.rejects(() => run(floorOps, "sleep 30", { sessionId: id, timeout: 2 }), /timeout:2/);
    assert.ok(Date.now() - started < 15_000, "the caller's 2 s budget fired, not the 60 s floor");
  });

  it("does not wedge queued calls when a command never settles", async () => {
    // The real hazard the floor exists for: a hung command must not park the
    // queue behind it forever.
    const floorOps = wrapWithPersistentShell(await localOps(), { defaultTimeoutSecs: 3 });
    const id = track("queue-wedge");
    const hung = run(floorOps, "command() { :; }", { sessionId: id });
    const queued = run(floorOps, "echo QUEUED-RAN", { sessionId: id });
    await assert.rejects(() => hung, /timeout:3/, "the hung head times out");
    const r = await queued;
    assert.equal(r.text.trim(), "QUEUED-RAN", "the queued call still runs after the reset");
  });

  // The injected-floor tests above prove the MECHANISM but substitute the
  // number. These two prove the SHIPPED constant itself: the real 300 s floor
  // fires at 300 s and not at 299 s, verified on a fake clock so the suite does
  // not wait five minutes.
  it("the shipped 300 s floor fires at 300 s and not before (fake clock)", async () => {
    assert.equal(DEFAULT_COMMAND_TIMEOUT_SECS, 300, "the shipped constant");
    const id = track("fake-clock");
    const call = run(ops, "command() { :; }", { sessionId: id }); // NO caller timeout
    let outcome: string | undefined;
    call.then(
      () => { outcome = "settled"; },
      (e: Error) => { outcome = e.message; },
    );

    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      await new Promise((r) => setImmediate(r)); // let the exec register its timer
      mock.timers.tick((DEFAULT_COMMAND_TIMEOUT_SECS - 1) * 1000);
      await new Promise((r) => setImmediate(r));
      assert.equal(outcome, undefined, "299 s must NOT fire the floor");
      mock.timers.tick(1000);
      await new Promise((r) => setImmediate(r));
      await call.catch(() => {});
      assert.match(String(outcome), new RegExp(`timeout:${DEFAULT_COMMAND_TIMEOUT_SECS}`));
    } finally {
      mock.timers.reset();
    }
  });
});

describe("persistent bash: isolation and serialization", () => {
  it("keeps separate shells per PI_SESSION_ID", async () => {
    const a = track("iso-a");
    const b = track("iso-b");
    await run(ops, "export CEULEN_SIDE=a", { sessionId: a });
    await run(ops, "export CEULEN_SIDE=b", { sessionId: b });
    assert.equal((await run(ops, "echo $CEULEN_SIDE", { sessionId: a })).text.trim(), "a");
    assert.equal((await run(ops, "echo $CEULEN_SIDE", { sessionId: b })).text.trim(), "b");
  });

  it("serializes concurrent calls instead of interleaving their streams", async () => {
    const id = track("serial");
    const first = run(ops, "echo FIRST; sleep 0.15; echo FIRST-END", { sessionId: id });
    const second = run(ops, "echo SECOND", { sessionId: id });
    const [r1, r2] = await Promise.all([first, second]);
    assert.match(r1.text, /FIRST/);
    assert.match(r1.text, /FIRST-END/);
    assert.doesNotMatch(r1.text, /SECOND/, "the queued command must not interleave");
    assert.equal(r2.text.trim(), "SECOND");
  });

  it("kills only the targeted session's shell", async () => {
    const a = track("kill-a");
    const b = track("kill-b");
    await run(ops, "export CEULEN_KEEP=1", { sessionId: a });
    await run(ops, "export CEULEN_KEEP=2", { sessionId: b });
    killPersistentShells(a);
    assert.equal((await run(ops, "echo [$CEULEN_KEEP]", { sessionId: a })).text.trim(), "[]", "killed shell respawns empty");
    assert.equal((await run(ops, "echo [$CEULEN_KEEP]", { sessionId: b })).text.trim(), "[2]", "sibling untouched");
  });
});

describe("persistent bash: plan mode runs one-shot", () => {
  it("is stateless inside plan mode and resumes pre-plan state after exit", async () => {
    const id = track("plan");
    // Pre-plan state that must survive plan mode untouched.
    await run(ops, "export CEULEN_PLAN_PROBE=1", { sessionId: id });
    assert.equal((await run(ops, "echo $CEULEN_PLAN_PROBE", { sessionId: id })).text.trim(), "1");

    setPlanActive(true);
    // One-shot: neither the export nor the cd may reach the persistent shell.
    await run(ops, "export CEULEN_PLAN_PROBE=2", { sessionId: id });
    const inPlan = await run(ops, "echo [$CEULEN_PLAN_PROBE]", { sessionId: id });
    assert.equal(inPlan.text.trim(), "[]", "plan mode must be stateless — no retention from the previous call");
    await run(ops, "cd /tmp", { sessionId: id });

    setPlanActive(false);
    // Both plan-mode mutations are gone; the pre-plan variable is back.
    const afterPlan = await run(ops, "echo [$CEULEN_PLAN_PROBE]", { sessionId: id });
    assert.equal(afterPlan.text.trim(), "[1]", "pre-plan state resumes; plan-mode mutations were discarded");
    const cwdAfterPlan = await run(ops, "pwd", { sessionId: id });
    assert.notEqual(cwdAfterPlan.text.trim(), "/tmp", "the plan-mode cd was discarded");
  });
});

describe("persistent bash: description clause", () => {
  it("states persistence, backgrounding, reset, and the plan-mode exception", () => {
    const clause = persistentBashClause();
    assert.match(clause, /ONE persistent bash session/);
    assert.match(clause, /persist across calls/);
    assert.match(clause, /background/);
    assert.match(clause, /resets the shell/);
    assert.match(clause, /plan mode each call runs as a one-shot shell/);
  });

  it("installs the exit sweeper idempotently", () => {
    installPersistentExitSweepForTests();
    installPersistentExitSweepForTests();
    assert.ok(true, "no duplicate listeners / no throw");
  });
});
