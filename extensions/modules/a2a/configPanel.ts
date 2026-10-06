// a2a's /config contribution — Tasks tab, A2A sections (📡).
//
// ceulen port: upstream @bacnh85/pi-a2a 0.7.13 shipped its own /a2a-config
// panel over @bacnh85/pi-config-panel — DROPPED here, the central /config
// panel owns A2A settings (web-module pattern). Rows are keyed `a2a.*`; the
// Enable row + per-tool toggles are prepended/appended by the config module
// (withEnableRow/withToolRows over the registry entry).
//
// Save path reuses upstream's pure patch builder (buildA2ASettingsPatch) +
// writer (writeSettingsA2A): env-sourced secrets are never copied to disk
// unless their exact row was edited, gateway blocks survive unrelated edits,
// peer timeouts convert settings-seconds → runtime-ms on the write side.
// Live apply via setConfigOverrides (config is read per call — no /reload),
// and a running inbound server restarts through the index.ts bridge when
// server/discovery config changed.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { row, toInt, type PanelGroup } from "../../lib/panel.js";
import type { ModuleConfig } from "../../lib/registry.js";
import { isProjectTrusted } from "../../lib/registry.js";
import {
  buildA2ASettingsPatch,
  loadConfig,
  setConfigOverrides,
  writeSettingsA2A,
  GATEWAY_KEY_RE,
  type A2AConfig,
  type GatewayEntry,
  type Peer,
} from "./lib/config.js";
import { a2aServerRunning as a2aServerRunningIndex, restartA2AServer as restartA2AServerIndex } from "./index.js";
import { writeSecretEnvs } from "../../lib/env.js";

/** Env var name for one gateway secret (per-key diversion). */
function gatewayTokenEnv(key: string, field: "token" | "upstreamToken"): string {
  const keyEnv = key.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  return field === "token" ? `A2A_GATEWAY_${keyEnv}_TOKEN` : `A2A_GATEWAY_${keyEnv}_UPSTREAM_TOKEN`;
}

/** Restart bridge — defaults to the index.ts exports; tests inject via
 *  __setRestartBridgeForTests (the panel must not spin real servers). */
const bridge = {
  a2aServerRunning: (): boolean => a2aServerRunningIndex(),
  restartA2AServer: (piApi: ExtensionAPI, ctx: ExtensionContext): Promise<void> => restartA2AServerIndex(piApi, ctx),
};
/** Test seam. */
export function __setRestartBridgeForTests(over: { a2aServerRunning: () => boolean; restartA2AServer: (pi: ExtensionAPI, ctx: ExtensionContext) => Promise<void> } | null): void {
  bridge.a2aServerRunning = over?.a2aServerRunning ?? ((): boolean => a2aServerRunningIndex());
  bridge.restartA2AServer = over?.restartA2AServer ?? ((pi2: ExtensionAPI, ctx2: ExtensionContext) => restartA2AServerIndex(pi2, ctx2));
}

/** The inline prompt the panel kernel hands an action row. */
type ActionPrompt = (label: string, onDone: (value: string | undefined) => void) => void;

/** Env vars that shadow a saved field — disclosed in the save notify when the
 *  edited field's env override is set (web-module env-disclosure pattern). */
const ENV_SHADOW: Record<string, string> = {
  "server.enabled": "A2A_SERVER_ENABLED",
  "server.port": "A2A_PORT",
  "server.portFallback": "A2A_PORT_FALLBACK",
  "server.host": "A2A_HOST",
  "server.agentName": "A2A_AGENT_NAME",
  "server.replyTimeoutSec": "A2A_REPLY_TIMEOUT",
  "server.asyncTimeoutSec": "A2A_ASYNC_TIMEOUT",
  "server.maxConcurrent": "A2A_MAX_CONCURRENT",
  "server.maxPingpongTurns": "A2A_MAX_PINGPONG_TURNS",
  "server.rateLimitPerMin": "A2A_RATE_LIMIT",
  "server.allowAllUsers": "A2A_ALLOW_ALL_USERS",
  "server.childTranscripts": "A2A_CHILD_TRANSCRIPTS",
  "server.childTranscriptRetentionDays": "A2A_CHILD_TRANSCRIPT_RETENTION_DAYS",
  selfIdentity: "A2A_SELF_IDENTITY",
  "discovery.local.enabled": "A2A_DISCOVERY_LOCAL",
  "discovery.local.heartbeatSec": "A2A_HEARTBEAT_SEC",
  "discovery.local.ttlSec": "A2A_TTL_SEC",
  "discovery.mdns.enabled": "A2A_DISCOVERY_MDNS",
  "discovery.mdns.serviceType": "A2A_MDNS_TYPE",
  "discovery.enrichCard": "A2A_ENRICH_CARD",
  "ui.transcript": "A2A_UI_TRANSCRIPT",
  "gateway.url": "A2A_GATEWAY_URL",
  "gateway.token": "A2A_GATEWAY_TOKEN",
  "gateway.enabled": "A2A_GATEWAY_ENABLED",
};

/** Read a dotted settings path off a config object ("a2a." already stripped). */
function pathValue(cfg: A2AConfig, key: string): unknown {
  let cur: any = cfg;
  for (const part of key.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[part];
  }
  return cur;
}

/** Set a dotted path on the working config (row setters). */
function setPathValue(cfg: A2AConfig, key: string, value: unknown): void {
  const parts = key.split(".");
  let cur: any = cfg;
  for (const part of parts.slice(0, -1)) {
    if (cur[part] == null || typeof cur[part] !== "object") cur[part] = {};
    cur = cur[part];
  }
  cur[parts[parts.length - 1]!] = value;
}

/** Build the two A2A panel groups over the working config (mutated by row
 *  setters). Exported for tests. `onMutate` flags structural edits from
 *  action rows (peers/gateways) — they change the config without editing a
 *  row key, and the save path needs to know. */
export function buildA2AGroups(
  working: A2AConfig,
  hooks: {
    markPeerChange: () => void;
    markGatewayChange: () => void;
  },
): PanelGroup[] {
  const rowFor = (
    key: string, // after "a2a."
    label: string,
    kind: "toggle" | "string" | "number",
    opts: Parameters<typeof row>[5] = {},
  ) =>
    row(
      `a2a.${key}`,
      label,
      kind,
      pathValue(working, key),
      (v) => {
        setPathValue(working, key, kind === "number" ? toInt(v, Number(pathValue(working, key) ?? 0)) : v);
      },
      opts,
    );

  // Panel key namespaces (gw.<key>.*, gateway.*, peer.<name>.*) do NOT mirror
  // config paths (discovery.gateways.<key>.*, peers.<name>.*) — these rows use
  // EXPLICIT setters mutating the entry objects (upstream panel pattern), not
  // the generic path helper.
  const gatewayEntryRows = (prefix: string, get: () => GatewayEntry, view: GatewayEntry): ReturnType<typeof row>[] => [
    row(`a2a.${prefix}.enabled`, "Registration", "toggle", view.enabled, (v) => {
      get().enabled = Boolean(v);
      hooks.markGatewayChange();
    }),
    row(`a2a.${prefix}.url`, "Gateway URL", "string", view.url, (v) => {
      get().url = String(v ?? "");
      hooks.markGatewayChange();
    }),
    row(`a2a.${prefix}.token`, "API token", "string", view.token ?? "", (v) => {
      get().token = String(v ?? "");
      hooks.markGatewayChange();
    }, { mask: true, description: "Gateway API token. Edit to replace — empty submit is a no-op; unedited tokens are never copied to disk from env." }),
    row(`a2a.${prefix}.name`, "Peer name", "string", view.name ?? "", (v) => {
      get().name = v ? String(v) : undefined;
      hooks.markGatewayChange();
    }, { description: "Optional registration name override (default <agentName>-<port>)." }),
    row(`a2a.${prefix}.upstreamToken`, "Upstream token", "string", view.upstreamToken ?? "", (v) => {
      get().upstreamToken = v ? String(v) : undefined;
      hooks.markGatewayChange();
    }, { mask: true, description: "Optional token the gateway presents when proxying TO this session." }),
    row(`a2a.${prefix}.heartbeatSec`, "Heartbeat (s)", "number", view.heartbeatSec ?? 60, (v) => {
      get().heartbeatSec = toInt(v, get().heartbeatSec ?? 60);
      hooks.markGatewayChange();
    }),
    row(`a2a.${prefix}.channel`, "Reverse channel", "toggle", view.channel ?? true, (v) => {
      get().channel = Boolean(v);
      hooks.markGatewayChange();
    }, { description: "Open a reverse channel so firewalled peers can call this session." }),
  ];

  // Materializing accessors (upstream panel pattern): setters materialize the
  // block on first edit so a toggle/URL entry creates it in the working config
  // without clobbering an env-sourced gateway on unrelated edits.
  const gwView = working.discovery.gateway ?? { enabled: false, url: "", token: "" };
  const gw = () => (working.discovery.gateway ??= { enabled: false, url: "", token: "" });
  // "Live" = any field differs from the inert placeholder loadConfig
  // materializes — an inert block renders nothing (upstream parity).
  const gatewayLive =
    working.discovery.gateway != null &&
    (Boolean(gwView.enabled) || Boolean(gwView.url) || Boolean(gwView.token) ||
      gwView.name != null || gwView.upstreamToken != null ||
      (gwView.heartbeatSec ?? 60) !== 60 || (gwView.channel ?? true) !== true);

  const serverRows: ReturnType<typeof row>[] = [
    rowFor("server.enabled", "Server enabled", "toggle", {
      warning:
        "Security-relevant keys (enabled/host/tokens) are read from GLOBAL settings/env only — a project settings file cannot enable the server.",
      description: "Auto-start the inbound A2A server on session start (host sessions only). /a2a-server start|stop manages it live.",
    }),
    rowFor("server.port", "Port", "number", { defaultValue: 9910, description: "Inbound port. If busy, climbs port+1…+portFallback, then OS-assigned." }),
    rowFor("server.portFallback", "Port fallback", "number", { defaultValue: 10, description: "Consecutive ports to try when the configured port is busy. 0 = configured port only, then OS-assigned." }),
    rowFor("server.host", "Bind host", "string", {
      defaultValue: "127.0.0.1",
      warning: "Widen to 0.0.0.0 ONLY with a shared token set — remote exposure requires a bearer token AND an explicit host.",
    }),
    rowFor("server.agentName", "Agent name", "string", { description: "Name on the Agent Card (default <hostname>-<port> once started)." }),
    rowFor("server.maxConcurrent", "Max concurrent", "number", { defaultValue: 3, description: "Max concurrent inbound tasks (blocking AND detached — each detached run pins a slot until it reaches a terminal state)." }),
    rowFor("server.replyTimeoutSec", "Reply timeout (s)", "number", { defaultValue: 300, description: "Blocking-send reply window in seconds. 0 = unbounded (request stays open until the run settles)." }),
    rowFor("server.asyncTimeoutSec", "Async timeout (s)", "number", { defaultValue: 86400, description: "Supervision window for detached (returnImmediately) tasks; the kill switch that frees a pinned concurrency slot. 0 = caller-supervised." }),
    rowFor("server.maxPingpongTurns", "Max ping-pong turns", "number", { defaultValue: 5, description: "Anti-loop turn cap per context (max 20)." }),
    rowFor("server.rateLimitPerMin", "Rate limit /min", "number", { defaultValue: 60, description: "Requests/minute per authenticated identity." }),
    rowFor("server.allowAllUsers", "Allow all users", "toggle", {
      defaultValue: false,
      warning: "Dev only — admits any authenticated peer.",
    }),
    rowFor("server.childTranscripts", "Child transcripts", "toggle", { defaultValue: true, description: "Persist each dispatched child session's transcript to <agentDir>/a2a_sessions/ (forensic step history). Off = in-memory only." }),
    rowFor("server.childTranscriptRetentionDays", "Transcript retention (days)", "number", { defaultValue: 30, description: "Delete child transcripts older than N days on server start. 0 = keep forever (transcripts carry everything the worker read)." }),
    rowFor("selfIdentity", "Caller identity", "string", { description: "This session's outbound caller identity — a key in server.peerTokens (settings.json/env; not editable here). Empty = shared token (anonymous caller)." }),
    rowFor("ui.transcript", "Transcript messages", "toggle", { defaultValue: true, description: "Show inbound task activity as transcript messages. Off = toasts + footer only." }),
  ];

  // Peers group rows: one URL row per configured peer + add/remove actions.
  const peerRows: ReturnType<typeof row>[] = Object.entries(working.peers).map(([name, p]) => {
    const peer = p as Peer;
    return row(`a2a.peer.${name}.url`, `Peer ${name} URL`, "string", peer.url, (v) => {
      peer.url = String(v ?? "");
      hooks.markPeerChange();
    }, {
      description: peer.description
        ? `${peer.url ? "" : "URL not set. "}${peer.capabilities.length ? `Capabilities: ${peer.capabilities.join(", ")}.` : "No capabilities advertised."}`
        : "Peer endpoint. Auth tokens/capabilities are settings.json-only (a2a.peers.<name>), not editable here.",
    });
  });
  peerRows.push({
    key: "a2a.action.addPeer",
    label: "+ Add peer",
    kind: "action",
    value: undefined,
    set: (prompt: ActionPrompt) => {
      // Re-prompt with the reason on bad input — a silent return reads as a
      // dead panel (the reported "only the key prompt shows" confusion).
      // Esc (undefined) or empty first answer = cancel.
      const askUrl = (name: string, hint?: string) =>
        prompt(hint ?? "Peer URL (http://…)", (url) => {
          if (url === undefined) return;
          if (!url.trim()) return void askUrl(name, `URL required — Peer URL for '${name}'`);
          working.peers[name] = { url: url.trim(), auth: { type: "none" }, timeout: 120000, capabilities: [] };
          hooks.markPeerChange();
        });
      const askName = (hint?: string) =>
        prompt(hint ?? "Peer name", (name) => {
          if (!name) return;
          if (working.peers[name]) return void askName(`'${name}' exists — another name (Esc, then edit its URL row)`);
          askUrl(name);
        });
      askName();
    },
  });
  peerRows.push({
    key: "a2a.action.removePeer",
    label: "− Remove peer",
    kind: "action",
    value: undefined,
    set: (prompt: ActionPrompt) => {
      const names = Object.keys(working.peers);
      if (names.length === 0) return;
      const ask = (hint?: string) =>
        prompt(hint ?? `Remove peer (${names.join(", ")})`, (pick) => {
          if (!pick) return;
          if (!working.peers[pick]) return void ask(`No peer '${pick}' — one of: ${names.join(", ")}`);
          delete working.peers[pick];
          hooks.markPeerChange();
        });
      ask();
    },
  });

  // Gateways map rows: one block per configured entry + add/remove actions.
  const gwMapRows: ReturnType<typeof row>[] = [];
  for (const [key, entry] of Object.entries(working.discovery.gateways ?? {})) {
    const g = () => (working.discovery.gateways![key] ??= { enabled: false, url: "", token: "" });
    gwMapRows.push(...gatewayEntryRows(`gw.${key}`, () => g()!, entry).map((r) => r));
  }
  gwMapRows.push({
    key: "a2a.action.addGateway",
    label: "+ Add gateway",
    kind: "action",
    value: undefined,
    set: (prompt: ActionPrompt) => {
      // Same re-prompt-with-reason discipline as addPeer: a pasted URL or a
      // space in the key must bounce with an explanation, not die silently.
      const askUrl = (key: string, hint?: string) =>
        prompt(hint ?? `Gateway URL for '${key}'`, (url) => {
          if (url === undefined) return;
          if (!url.trim()) return void askUrl(key, `URL required — Gateway URL for '${key}'`);
          prompt(`API token for '${key}' (Enter = none)`, (token) => {
            if (token === undefined) return;
            working.discovery.gateways ??= {};
            working.discovery.gateways[key] = { enabled: true, url: url.trim(), token: token.trim() };
            hooks.markGatewayChange();
          });
        });
      const askKey = (hint?: string) =>
        prompt(hint ?? "Gateway key (letters/digits/._-, e.g. work)", (key) => {
          if (!key) return;
          if (!GATEWAY_KEY_RE.test(key)) return void askKey(`Invalid key '${key}' — letters/digits/._- only`);
          if (working.discovery.gateways?.[key]) return void askKey(`'${key}' exists — another key (Esc, then edit its rows)`);
          askUrl(key);
        });
      askKey();
    },
  });
  gwMapRows.push({
    key: "a2a.action.removeGateway",
    label: "− Remove gateway",
    kind: "action",
    value: undefined,
    set: (prompt: ActionPrompt) => {
      const keys = Object.keys(working.discovery.gateways ?? {});
      if (keys.length === 0) return;
      const ask = (hint?: string) =>
        prompt(hint ?? `Remove gateway (${keys.join(", ")})`, (pick) => {
          if (!pick) return;
          if (!working.discovery.gateways?.[pick]) return void ask(`No gateway '${pick}' — one of: ${keys.join(", ")}`);
          delete working.discovery.gateways[pick];
          hooks.markGatewayChange();
        });
      ask();
    },
  });

  return [
    { key: "a2a", label: "A2A", tab: "Tasks", icon: "📡", rows: serverRows },
    {
      key: "a2a-net",
      label: "A2A peers & discovery",
      tab: "Tasks",
      rows: [
        rowFor("discovery.local.enabled", "Local registry", "toggle", { defaultValue: true, description: "Local file registry (<agentDir>/a2a_registry/) — instant same-machine discovery." }),
        rowFor("discovery.local.heartbeatSec", "Heartbeat (s)", "number", { defaultValue: 15, description: "Registry heartbeat interval." }),
        rowFor("discovery.local.ttlSec", "Registry TTL (s)", "number", { defaultValue: 60, description: "Registry entry TTL before stale-sweep." }),
        rowFor("discovery.mdns.enabled", "mDNS broadcast", "toggle", { defaultValue: false, description: "LAN discovery via _a2a._tcp (vendored bonjour; announces a unique <hostname>-a2a-<pid> name so it cannot rename your Mac)." }),
        rowFor("discovery.mdns.serviceType", "mDNS service type", "string", { defaultValue: "a2a", description: "Advertised as _<type>._tcp." }),
        rowFor("discovery.enrichCard", "Enrich Agent Card", "toggle", {
          defaultValue: true,
          warning: "Publishes cwd/pid/model into the Agent Card metadata.",
        }),
        // Legacy single gateway block (env/settings-sourced) — hidden when inert.
        ...(gatewayLive
          ? gatewayEntryRows("gateway", () => gw()!, gwView).map((r) => r)
          : []),
        ...peerRows,
        ...gwMapRows,
      ],
    },
  ];
}

const A2A_ENV_NAMES = new Set(Object.values(ENV_SHADOW).concat(["A2A_BEARER_TOKEN", "A2A_PEER_TOKENS", "A2A_PUBLIC_URL", "A2A_VERIFY_SSL", "A2A_RETRY", "A2A_TRUSTED_PEERS"]));

/** a2a's ModuleConfig for the central /config panel. The factory receives the
 *  module's OWN guarded pi (loader contract) and threads it to the restart
 *  bridge. Working copy + change flags live in the closure; save() diffs
 *  against the pre-open snapshot (upstream /a2a-config save semantics). */
export function a2aConfig(pi: ExtensionAPI): ModuleConfig {
  const before = loadConfig({ cwd: process.cwd() });
  const working = structuredClone(before);
  let peerChanges = false;
  let gatewayChanged = false;

  return {
    groups: () => buildA2AGroups(working, {
      markPeerChange: () => {
        peerChanges = true;
      },
      markGatewayChange: () => {
        gatewayChanged = true;
      },
    }),
    save: async (edited, ctx) => {
      // Diff-based gate: action rows mutate structure without editing a row
      // key, so editedKeys alone under-reports (makeOnAction marks dirty,
      // which triggers this save; the diff decides whether anything changed).
      peerChanges ||= JSON.stringify(working.peers) !== JSON.stringify(before.peers);
      gatewayChanged ||=
        JSON.stringify(working.discovery.gateway ?? null) !== JSON.stringify(before.discovery.gateway ?? null) ||
        JSON.stringify(working.discovery.gateways ?? null) !== JSON.stringify(before.discovery.gateways ?? null);
      const ownedKeyEdited = [...edited].some((k) => k.startsWith("a2a."));
      if (!ownedKeyEdited && !peerChanges && !gatewayChanged) return;

      const editedGatewayKeys = new Set(
        [...edited]
          .filter((k) => k.startsWith("a2a.gateway.") || k.startsWith("a2a.gw."))
          .map((k) => k.slice("a2a.".length)),
      );
      const builtPatch = buildA2ASettingsPatch({
        cfg: before,
        working,
        peerChanges,
        gatewayChanged,
        editedGatewayKeys,
      });
      // SECRETS DIVERSION: gateway tokens never persist in settings.json.
      // Tokens the user actually edited → .env.local (0600, ingested at
      // startup, env wins at read time); the loader's per-key env fallback
      // (config.ts) resolves them at read time. The settings patch keeps
      // every non-secret field (URL, name, heartbeat, enabled).
      const secretEnvs: Record<string, string> = {};
      const diverted = (patch: (a2a: any) => any): (a2a: any) => any => (a2a: any) => {
        const out = patch(a2a);
        if (out?.discovery && typeof out.discovery === "object") {
          const scrub = (entry: Record<string, any>, key: string | null, editedToken: boolean, editedUpstream: boolean) => {
            if (editedToken && entry.token) {
              secretEnvs[key ? gatewayTokenEnv(key, "token") : "A2A_GATEWAY_TOKEN"] = String(entry.token);
              entry.token = "";
            }
            if (editedUpstream && entry.upstreamToken) {
              secretEnvs[key ? gatewayTokenEnv(key, "upstreamToken") : "A2A_GATEWAY_UPSTREAM_TOKEN"] = String(entry.upstreamToken);
              entry.upstreamToken = undefined;
            }
          };
          if (out.discovery.gateway && typeof out.discovery.gateway === "object") {
            scrub(out.discovery.gateway, null, editedGatewayKeys.has("gateway.token"), editedGatewayKeys.has("gateway.upstreamToken"));
          }
          if (out.discovery.gateways && typeof out.discovery.gateways === "object") {
            for (const [k, entry] of Object.entries(out.discovery.gateways as Record<string, any>)) {
              if (entry && typeof entry === "object") {
                scrub(entry, k, editedGatewayKeys.has(`gw.${k}.token`), editedGatewayKeys.has(`gw.${k}.upstreamToken`));
              }
            }
          }
        }
        return out;
      };
      const written = writeSettingsA2A({
        cwd: ctx.cwd,
        patch: diverted(builtPatch),
      });
      const savedSecrets = Object.keys(secretEnvs).length > 0 ? writeSecretEnvs(secretEnvs) : [];

      // Live apply — config is read per call; no /reload needed.
      setConfigOverrides({
        peers: working.peers,
        selfIdentity: working.selfIdentity,
        server: working.server,
        discovery: working.discovery,
        ui: working.ui,
      });

      const notes = [`A2A config saved to ${written} — applied live.`];
      if (savedSecrets.length) notes.push(`Gateway token(s) saved to .env.local (${savedSecrets.length}) — never settings.json.`);
      // Env overrides still shadowing edited fields.
      const envOverrides = [...edited]
        .map((k) => (k.startsWith("a2a.") ? ENV_SHADOW[k.slice("a2a.".length)] : undefined))
        .filter((v): v is string => v !== undefined && process.env[v] !== undefined);
      if (envOverrides.length) notes.push(`Still overridden by env: ${[...new Set(envOverrides)].join(", ")}.`);
      if (A2A_ENV_NAMES.has("A2A_BEARER_TOKEN") && process.env.A2A_BEARER_TOKEN && edited.has("a2a.server.enabled")) {
        // sharedToken comes from env; enabling the server is still token-gated.
        notes.push("Server shared token comes from A2A_BEARER_TOKEN / settings.json server.sharedToken.");
      }
      // Trusted project shadow disclosure (web-module pattern).
      if (ctx.isProjectTrusted?.() === true) {
        const project = loadConfig({ cwd: ctx.cwd });
        void project;
        try {
          const fs = await import("node:fs");
          const raw = JSON.parse(fs.readFileSync(`${ctx.cwd}/.pi/settings.json`, "utf-8")) as { a2a?: unknown };
          if (raw?.a2a && typeof raw.a2a === "object") {
            notes.push("A trusted project .pi/settings.json a2a section also applies (security keys sanitized).");
          }
        } catch {
          /* no project file */
        }
      }
      ctx.ui.notify(notes.join(" "), "info");

      // Restart the running inbound server when server/discovery config changed.
      const restartChanged =
        JSON.stringify(working.server) !== JSON.stringify(before.server) ||
        JSON.stringify(working.discovery) !== JSON.stringify(before.discovery);
      if (restartChanged && bridge.a2aServerRunning()) {
        await bridge.restartA2AServer(pi, ctx);
      }
    },
  };
}

/** Exposed for tests. */
export { GATEWAY_KEY_RE };
