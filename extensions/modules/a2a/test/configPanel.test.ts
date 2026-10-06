/** configPanel.ts tests — the /config contribution: row keys, masked secrets,
 *  diff-gated save, patch-builder invariants driven through the contribution,
 *  restart bridge wiring. Port of the load-bearing halves of upstream
 *  config-panel.test.ts (the old kernel panel itself is dropped). */
import { describe, it, beforeEach, afterEach } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { assert } from "./chai.js";
import { buildA2AGroups, a2aConfig } from "../configPanel.ts";
import { loadConfig, setConfigOverrides } from "../lib/config.ts";
import { DEFAULTS } from "./helpers.js";

const tmpDirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return fs.realpathSync(dir);
}

async function withIsolatedPiDir<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = makeTempDir("pi-a2a-cfgp-");
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    // AWAIT async bodies: restoring env in a sync finally around an async
    // callback unsets the isolation while the body is still running (the
    // token-save test wrote to the OUTER PI dir — the classic bug).
    return await fn(dir);
  } finally {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = old;
  }
}

function withoutA2AEnv<T>(fn: () => T): T {
  const saved = Object.entries(process.env).filter(([k]) => k.startsWith("A2A_")) as [string, string][];
  for (const [k] of saved) delete process.env[k];
  try {
    return fn();
  } finally {
    for (const [k, v] of saved) process.env[k] = v;
  }
}

type Row = { key: string; label: string; kind: string; value: unknown; set: (v: unknown) => void; opts?: any };
function rowsOf(groups: ReturnType<typeof buildA2AGroups>): Row[] {
  return groups.flatMap((g) => g.rows as unknown as Row[]);
}
function rowAt(groups: ReturnType<typeof buildA2AGroups>, key: string): Row {
  const r = rowsOf(groups).find((r) => r.key === key);
  assert.exists(r, `row ${key} exists`);
  return r!;
}

const noopHooks = { markPeerChange: () => {}, markGatewayChange: () => {} };
type SaveFn = (edited: Set<string>, ctx: any) => Promise<void>;

interface SavedCall {
  notes: string[];
}
function makeCtx(dir: string) {
  const saved: SavedCall = { notes: [] };
  const ctx = {
    cwd: dir,
    isProjectTrusted: () => false,
    ui: {
      notify: (msg: string) => {
        saved.notes.push(msg);
      },
    },
  };
  return { ctx, saved };
}

describe("configPanel contribution", () => {
  beforeEach(() => {
    savedEnv.PI_CODING_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;
    setConfigOverrides(null); // hermetic: a prior test's live overrides must not leak into this factory's snapshot
  });
  afterEach(() => {
    process.env.PI_CODING_AGENT_DIR = savedEnv.PI_CODING_AGENT_DIR;
    setConfigOverrides(null);
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("builds two A2A groups on the Tasks tab with a2a.-prefixed row keys", () => {
    withIsolatedPiDir(() => {
      const groups = buildA2AGroups(loadConfig({ cwd: process.cwd() }), noopHooks);
      assert.lengthOf(groups, 2);
      assert.equal(groups[0]!.label, "A2A");
      assert.equal(groups[1]!.label, "A2A peers & discovery");
      assert.isTrue(groups.every((g) => g.tab === "Tasks"));
      const keys = rowsOf(groups).map((r) => r.key);
      assert.isTrue(keys.every((k) => k.startsWith("a2a.")), `all keys a2a.-prefixed: ${keys.filter((k) => !k.startsWith("a2a."))}`);
      for (const must of [
        "a2a.server.enabled",
        "a2a.server.port",
        "a2a.server.host",
        "a2a.server.maxConcurrent",
        "a2a.server.replyTimeoutSec",
        "a2a.server.asyncTimeoutSec",
        "a2a.server.allowAllUsers",
        "a2a.selfIdentity",
        "a2a.ui.transcript",
        "a2a.discovery.local.enabled",
        "a2a.discovery.mdns.enabled",
        "a2a.discovery.enrichCard",
        "a2a.action.addPeer",
        "a2a.action.removePeer",
        "a2a.action.addGateway",
        "a2a.action.removeGateway",
      ]) {
        assert.exists(keys.find((k) => k === must), `row ${must} present`);
      }
    });
  });

  it("renders NO gateway rows when the legacy block is inert; masked rows when live", () => {
    withoutA2AEnv(() =>
      withIsolatedPiDir(() => {
        const cfg = loadConfig({ cwd: process.cwd() });
        const inert = buildA2AGroups(cfg, noopHooks);
        assert.isFalse(rowsOf(inert).some((r) => r.key.startsWith("a2a.gateway.")), "inert legacy block hidden");

        cfg.discovery.gateway = { enabled: true, url: "http://gw.example:9920", token: "secret-token" };
        const live = buildA2AGroups(cfg, noopHooks);
        const tokenRow = rowAt(live, "a2a.gateway.token");
        assert.isTrue((tokenRow as any).mask === true, "gateway token row is masked");
        assert.equal(tokenRow.value, "secret-token");
      }),
    );
  });

  it("renders one URL row per configured peer + add/remove actions", () => {
    withoutA2AEnv(() =>
      withIsolatedPiDir(() => {
        const cfg = loadConfig({ cwd: process.cwd() });
        cfg.peers = {
          hermes: { url: "http://127.0.0.1:9900", auth: { type: "none" }, timeout: 120000, capabilities: [] },
        };
        const groups = buildA2AGroups(cfg, noopHooks);
        const peerRow = rowAt(groups, "a2a.peer.hermes.url");
        assert.equal(peerRow.value, "http://127.0.0.1:9900");
      }),
    );
  });

  it("save() no-ops when nothing was edited and no structure changed", () => {
    withoutA2AEnv(() =>
      withIsolatedPiDir((dir) => {
        const { ctx, saved } = makeCtx(dir);
        // Build the panel (working copy), touch NOTHING, save with no edits.
        const cfg = a2aConfig({} as never);
        cfg.groups();
        return Promise.resolve((cfg.save as SaveFn)(new Set(), ctx)).then(() => {
          assert.isFalse(fs.existsSync(path.join(dir, "settings.json")), "no settings write when clean");
          assert.equal(saved.notes.length, 0, "no notify when clean");
        });
      }),
    );
  });

  it("save() persists an edited scalar to the global settings file and applies live", async () => {
    await withoutA2AEnv(() =>
      withIsolatedPiDir(async (dir) => {
        const { ctx, saved } = makeCtx(dir);
        const cfg = a2aConfig({} as never);
        cfg.groups();
        // Simulate the row edit: flip server.port via the working copy path —
        // reach the row setter the panel would call.
        const groups = cfg.groups();
        const portRow = rowsOf(groups).find((r) => r.key === "a2a.server.port")!;
        portRow.set(9955);
        await (cfg.save as SaveFn)(new Set(["a2a.server.port"]), ctx);

        const written = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf-8"));
        assert.equal(written.a2a.server.port, 9955, "edited scalar persisted");
        // Live apply: loadConfig now resolves the override.
        assert.equal(loadConfig({ cwd: dir }).server.port, 9955, "override applied live");
        assert.include(saved.notes.join(" "), "applied live");
      }),
    );
  });

  it("add-gateway ACTION walks key → URL → token, re-prompts on a bad key, and persists", async () => {
    await withoutA2AEnv(() =>
      withIsolatedPiDir(async (dir) => {
        const { ctx } = makeCtx(dir);
        const cfg = a2aConfig({} as never);
        const addGw = rowsOf(cfg.groups()).find((r) => r.key === "a2a.action.addGateway")!;
        const prompts: Array<{ label: string; answer: (v: string | undefined) => void }> = [];
        (addGw.set as (p: any) => void)((label: string, onDone: (v: string | undefined) => void) => {
          prompts.push({ label, answer: onDone });
        });
        assert.lengthOf(prompts, 1, "key prompt opens");
        // Pasted URL as the key → bounce with an explanation, NOT a silent return
        // (the reported "only the key prompt shows" dead-panel bug).
        prompts[0]!.answer("http://bad");
        assert.lengthOf(prompts, 2, "invalid key re-prompts");
        assert.match(prompts[1]!.label, /Invalid key/);
        prompts[1]!.answer("work");
        assert.lengthOf(prompts, 3, "URL prompt follows a valid key");
        prompts[2]!.answer("http://127.0.0.1:9920");
        assert.lengthOf(prompts, 4, "token prompt follows the URL");
        prompts[3]!.answer("");
        await (cfg.save as SaveFn)(new Set(), ctx);

        const written = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf-8"));
        const gw = written.a2a.discovery.gateways.work;
        assert.exists(gw, "gateway persisted via the structural diff gate");
        assert.equal(gw.url, "http://127.0.0.1:9920");
        assert.equal(gw.token, "", "empty token allowed (Enter = none)");
        assert.isTrue(gw.enabled);
      }),
    );
  });

  it("add-gateway ACTION: Esc (undefined answer) cancels the flow at each step", async () => {
    await withoutA2AEnv(() =>
      withIsolatedPiDir(async (dir) => {
        const { ctx } = makeCtx(dir);
        // Step 1: Esc at the key prompt closes with no re-prompt.
        {
          const cfg = a2aConfig({} as never);
          const addGw = rowsOf(cfg.groups()).find((r) => r.key === "a2a.action.addGateway")!;
          const prompts: Array<{ label: string; answer: (v: string | undefined) => void }> = [];
          (addGw.set as (p: any) => void)((label: string, onDone: (v: string | undefined) => void) => prompts.push({ label, answer: onDone }));
          prompts[0]!.answer(undefined);
          assert.lengthOf(prompts, 1, "Esc on key prompt = cancel, no re-prompt");
          await (cfg.save as SaveFn)(new Set(), ctx);
          assert.isFalse(fs.existsSync(path.join(dir, "settings.json")), "cancel wrote nothing");
        }
        // Step 2: Esc at the URL prompt after a valid key — no gateway lands.
        {
          const cfg = a2aConfig({} as never);
          const addGw = rowsOf(cfg.groups()).find((r) => r.key === "a2a.action.addGateway")!;
          const prompts: Array<{ label: string; answer: (v: string | undefined) => void }> = [];
          (addGw.set as (p: any) => void)((label: string, onDone: (v: string | undefined) => void) => prompts.push({ label, answer: onDone }));
          prompts[0]!.answer("work");
          prompts[1]!.answer(undefined);
          assert.lengthOf(prompts, 2, "Esc on URL prompt = cancel, no re-prompt");
          await (cfg.save as SaveFn)(new Set(), ctx);
          if (fs.existsSync(path.join(dir, "settings.json"))) {
            const written = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf-8"));
            assert.isUndefined(written.a2a?.discovery?.gateways?.work, "cancelled flow left no gateway");
          }
        }
      }),
    );
  });

  it("an add-peer ACTION (no edited key) still persists — the diff gate", async () => {
    await withoutA2AEnv(() =>
      withIsolatedPiDir(async (dir) => {
        const { ctx } = makeCtx(dir);
        const cfg = a2aConfig({} as never);
        const addPeer = rowsOf(cfg.groups()).find((r) => r.key === "a2a.action.addPeer")!;
        // Drive the action's prompt flow: name → URL (chained inline prompts).
        const prompts: Array<{ label: string; answer: (v: string | undefined) => void }> = [];
        (addPeer.set as (p: any) => void)((label: string, onDone: (v: string | undefined) => void) => {
          prompts.push({ label, answer: onDone });
        });
        assert.lengthOf(prompts, 1, "first prompt (peer name) opens");
        prompts[0]!.answer("lab-agent");
        assert.lengthOf(prompts, 2, "second prompt (URL) opens after the name resolves");
        prompts[1]!.answer("http://127.0.0.1:9055");
        await (cfg.save as SaveFn)(new Set(), ctx); // NO edited keys — action only

        const written = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf-8"));
        assert.exists(written.a2a.peers["lab-agent"], "peer persisted via the structural diff gate");
        assert.equal(written.a2a.peers["lab-agent"].url, "http://127.0.0.1:9055");
        assert.equal(written.a2a.peers["lab-agent"].timeout, 120, "peers persist in SETTINGS units (seconds, not ms)");
      }),
    );
  });

  it("gateway token: an EDITED token diverts to .env.local — never settings.json; unrelated edits touch nothing", async () => {
    await withoutA2AEnv(() =>
      withIsolatedPiDir(async (dir) => {
        // Operator has a gateway configured in the GLOBAL file (env-sourced token case:
        // A2A_GATEWAY_TOKEN feeds the legacy block only, so seed the map via settings).
        // The save writer targets the GLOBAL (PI-dir) settings.json — upstream
        // design: never write repo-controlled files; writeSettingsA2A's cwd is
        // only the repo-exclusion input. Seed and verify THAT file.
        const globalSettings = path.join(process.env.PI_CODING_AGENT_DIR!, "settings.json");
        fs.writeFileSync(
          globalSettings,
          JSON.stringify({
            a2a: {
              discovery: { gateways: { work: { enabled: true, url: "http://gw:9920", token: "file-token" } } },
            },
          }),
        );
        const { ctx } = makeCtx(dir);
        const cfg = a2aConfig({} as never);
        cfg.groups();
        // Edit ONLY the heartbeat — the token row untouched.
        const hb = rowsOf(cfg.groups()).find((r) => r.key === "a2a.gw.work.heartbeatSec")!;
        hb.set(90);
        await (cfg.save as SaveFn)(new Set(["a2a.gw.work.heartbeatSec"]), ctx);
        let written = JSON.parse(fs.readFileSync(globalSettings, "utf-8"));
        assert.equal(written.a2a.discovery.gateways.work.token, "file-token", "unedited token survives an unrelated edit (legacy value untouched)");

        // Now edit the token itself → diverts to .env.local, scrubbed from settings.json.
        const cfg2 = a2aConfig({} as never);
        cfg2.groups();
        const tok = rowsOf(cfg2.groups()).find((r) => r.key === "a2a.gw.work.token")!;
        tok.set("rotated-token");
        await (cfg2.save as SaveFn)(new Set(["a2a.gw.work.token"]), ctx);
        written = JSON.parse(fs.readFileSync(globalSettings, "utf-8"));
        assert.ok(!written.a2a.discovery.gateways.work.token, "edited token must NOT persist in settings.json");
        const envLocal = fs.readFileSync(path.join(process.env.PI_CODING_AGENT_DIR!, ".env.local"), "utf-8");
        assert.match(envLocal, /A2A_GATEWAY_WORK_TOKEN=rotated-token/, "edited token diverted to .env.local");
        assert.equal(process.env.A2A_GATEWAY_WORK_TOKEN, "rotated-token", "live session resolves the diverted token immediately");
      }),
    );
  });

  it("server/discovery change with a running server invokes the restart bridge; unchanged config does not", async () => {
    await withoutA2AEnv(() =>
      withIsolatedPiDir(async (dir) => {
        let restarts = 0;
        const bridge = { isRunning: true, restart: async () => { restarts += 1; } };
        // configPanel reads the bridge from index.ts — inject via the factory's
        // test seam (module-level override the panel consults).
        const mod = (await import("../configPanel.ts")) as any;
        mod.__setRestartBridgeForTests({
          a2aServerRunning: () => bridge.isRunning,
          restartA2AServer: bridge.restart,
        });
        try {
          const { ctx } = makeCtx(dir);
          const cfg = mod.a2aConfig({} as never);
          cfg.groups();
          const port = rowsOf(cfg.groups()).find((r) => r.key === "a2a.server.port")!;
          port.set(9966); // server field → restartChanged
          await (cfg.save as SaveFn)(new Set(["a2a.server.port"]), ctx);
          assert.equal(restarts, 1, "running server restarts on server-config change");

          // ui.transcript change is NOT server/discovery → no restart.
          const cfg2 = mod.a2aConfig({} as never);
          cfg2.groups();
          const ui = rowsOf(cfg2.groups()).find((r) => r.key === "a2a.ui.transcript")!;
          ui.set(false);
          await (cfg2.save as SaveFn)(new Set(["a2a.ui.transcript"]), ctx);
          assert.equal(restarts, 1, "no restart on ui-only change");
        } finally {
          mod.__setRestartBridgeForTests(null);
        }
      }),
    );
  });

  it("defaults render as defaultValue on key rows", () => {
    withoutA2AEnv(() =>
      withIsolatedPiDir(() => {
        const groups = buildA2AGroups(loadConfig({ cwd: process.cwd() }), noopHooks);
        const defaults: Record<string, unknown> = {
          "a2a.server.port": 9910,
          "a2a.server.maxConcurrent": 3,
          "a2a.server.replyTimeoutSec": 300,
          "a2a.server.asyncTimeoutSec": 86400,
          "a2a.server.maxPingpongTurns": 5,
          "a2a.server.rateLimitPerMin": 60,
        };
        for (const [key, v] of Object.entries(defaults)) {
          assert.equal((rowAt(groups, key) as any).opts?.defaultValue ?? (rowAt(groups, key) as any).defaultValue, v, `${key} defaultValue`);
        }
      }),
    );
  });

  it("NOT rowed (upstream parity): sharedToken/peerTokens/workspace/publicUrl/skills have no rows", () => {
    withoutA2AEnv(() =>
      withIsolatedPiDir(() => {
        const keys = rowsOf(buildA2AGroups(loadConfig({ cwd: process.cwd() }), noopHooks)).map((r) => r.key);
        for (const banned of ["a2a.server.sharedToken", "a2a.server.peerTokens", "a2a.server.workspace", "a2a.server.publicUrl", "a2a.server.skills"]) {
          assert.isFalse(keys.includes(banned), `${banned} must not be a row`);
        }
      }),
    );
  });

  it("working-copy smoke: DEFAULTS() baseline matches loadConfig defaults", () => {
    withoutA2AEnv(() =>
      withIsolatedPiDir((dir) => {
        const cfg = loadConfig({ cwd: dir });
        assert.equal(cfg.server.port, DEFAULTS().server.port);
        assert.equal(cfg.discovery.local.enabled, DEFAULTS().discovery.local.enabled);
      }),
    );
  });
});
