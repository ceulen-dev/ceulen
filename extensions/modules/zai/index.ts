/**
 * zai — Z.AI Coding Plan via the Anthropic endpoint (provider id
 * `zai-anthropic`): the GLM-5.x catalogue with explicit prompt caching,
 * ZCode-parity fast mode, a cross-process dispatch gate, and ZCode Client
 * Request Signing V4.
 *
 * Wiring (ported from pi-model-tools' extension entry, re-gated on the
 * PROVIDER id instead of the model family — family detection belongs to
 * pi-model-tools, not to ceulen):
 *   - provider registration, unconditionally, at load
 *   - before_provider_request  → fast-mode body field
 *   - before_provider_headers  → dispatch gate → fast-mode beta → signing
 *   - after_provider_response  → 401 ladder for the signing handshake
 *   - /zai                     → status (never prints the key)
 *
 * Settings are read PER REQUEST (env > trusted project settings.json > global
 * settings.json > default), so a /config save or an env change applies without
 * /reload. Only the provider's registered baseUrl needs a re-register: the
 * load-time value, then once more on session_start when the trusted project
 * layer becomes readable.
 */

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import {
  PROVIDER_ID,
  applyFastModeBody,
  applyFastModeHeaders,
  isZaiAnthropicProvider,
  registerZaiAnthropicProvider,
} from "./lib/anthropic.js";
import { getZcodeSigningManager, applyZcodeSigningHeaders, pickZcodeCredential } from "./lib/signing.js";
import { defaultThrottlePaths, throttleZaiDispatch } from "./lib/throttle.js";
import { getZaiSettings, type ZaiResolvedSettings, type ZaiSettingSource } from "./lib/settings.js";

/** stderr debug, gated like the rest of ceulen (`CEULEN_ZAI_DEBUG`). */
function note(message: string): void {
  if (process.env.CEULEN_ZAI_DEBUG) process.stderr.write(`[ceulen-zai] ${message}\n`);
}

/** Base URL the provider is currently registered with (session_start compares
 *  against it to pick up a trust-gated project override). */
let registeredBaseUrl = "";

/** Register/re-register the provider with `baseUrl`. Exported so the /config
 *  contribution can live-apply a baseUrl change through the SAME path (its
 *  `pi` is the module's guarded one — the ownership claim stays ours). */
export function registerZai(pi: ExtensionAPI, baseUrl: string): void {
  registeredBaseUrl = baseUrl;
  registerZaiAnthropicProvider(pi, baseUrl);
}

export function zaiRegisteredBaseUrl(): string {
  return registeredBaseUrl;
}

/** Per-request settings: trust-gated so an untrusted checkout can't redirect
 *  the endpoint the API key is sent to. */
function settingsFor(ctx: ExtensionContext): ZaiResolvedSettings {
  return getZaiSettings({ cwd: ctx.cwd, trusted: ctx.isProjectTrusted?.() === true });
}

/** Closest-to-the-wire credential for signing: request header → env → auth.json. */
function signingCredential(headers: Record<string, string | null | undefined>): string | undefined {
  return pickZcodeCredential(headers, process.env, () => {
    try {
      const stored = readStoredCredential(PROVIDER_ID);
      return stored?.type === "api_key" ? stored.key : undefined;
    } catch {
      return undefined; // unreadable auth.json → fail open (unsigned)
    }
  });
}

/** Where the effective baseUrl came from, in words (never the value's secret). */
const BASE_URL_SOURCE_LABEL: Record<ZaiSettingSource, string> = {
  env: "env ZAI_ANTHROPIC_BASE_URL",
  project: "trusted project .pi/settings.json",
  global: "global settings.json",
  default: "built-in default",
};

/** Key presence (never the value). */
function keyStatus(): string {
  if (process.env.ZAI_ANTHROPIC_API_KEY?.trim()) return "set (env ZAI_ANTHROPIC_API_KEY)";
  try {
    const stored = readStoredCredential(PROVIDER_ID);
    if (stored?.type === "api_key") return "set (auth.json — /login zai-anthropic)";
  } catch { /* unreadable auth.json → report as unset */ }
  return "NOT set — run /login zai-anthropic or export ZAI_ANTHROPIC_API_KEY";
}

function statusLines(s: ZaiResolvedSettings, registered: string): string[] {
  const stale = s.baseUrl !== registered ? ` — re-registers on next session start` : "";
  return [
    "Z.AI Coding Plan (provider zai-anthropic)",
    `  Base URL: ${s.baseUrl}  (${BASE_URL_SOURCE_LABEL[s.sources.baseUrl]})${stale}`,
    `  Speed: ${s.speed}`,
    `  Signing: ${s.signing ? "on (fail-open)" : "off"}`,
    `  Dispatch gate: ${s.minIntervalMs > 0 ? `${s.minIntervalMs}ms between request starts` : "disabled"}`,
    `  API key: ${keyStatus()}`,
  ];
}

export default function (pi: ExtensionAPI) {
  // Unconditional registration (pi-router pattern): `apiKey:
  // "$ZAI_ANTHROPIC_API_KEY"` keeps /login zai-anthropic available and resolves
  // the key from auth.json or env at request time. Load-time settings are
  // env + global ONLY — no ctx/trust yet, and an untrusted checkout must not
  // own the endpoint the credential goes to (router's rule).
  registerZai(pi, getZaiSettings().baseUrl);

  // Signing events ride ceulen's own debug gate; without it the vendored
  // default logger (PI_MODEL_TOOLS_DEBUG) stays in place.
  if (process.env.CEULEN_ZAI_DEBUG) {
    getZcodeSigningManager().onEvent = (message) => note(message);
  }

  // session_start: the trusted project layer is readable now — re-register if
  // it flips the endpoint (no-op otherwise, so this is cheap).
  pi.on("session_start", (_event, ctx) => {
    const s = settingsFor(ctx);
    if (s.baseUrl !== registeredBaseUrl) {
      note(`session_start: baseUrl ${registeredBaseUrl} → ${s.baseUrl} (${s.sources.baseUrl})`);
      registerZai(pi, s.baseUrl);
    }
  });

  // Fast mode body field (`speed: "fast"`) — the tier ZCode uses. Headers ride
  // the beta list merged in before_provider_headers below.
  pi.on("before_provider_request", (event, ctx) => {
    if (!isZaiAnthropicProvider(ctx.model?.provider)) return;
    const payload = applyFastModeBody(event.payload, { provider: ctx.model?.provider, speed: settingsFor(ctx).speed });
    if (payload !== event.payload) return payload;
  });

  // Order matters and mirrors upstream: dispatch gate (spaces request STARTS
  // cross-process, mutex released before the request — streams are never
  // serialized) → fast-mode beta → ZCode signing (awaited: the runner
  // serializes headers right after handlers resolve, so the crypto must finish
  // inside this hook).
  pi.on("before_provider_headers", async (event, ctx) => {
    if (!isZaiAnthropicProvider(ctx.model?.provider)) return;
    const s = settingsFor(ctx);

    const waitedMs = await throttleZaiDispatch(ctx.model?.provider, process.env, defaultThrottlePaths(), {
      intervalMs: s.minIntervalMs,
      onError: (err) => note(`throttle fail-open: ${err.message}`),
    });
    if (waitedMs > 0) note(`throttle: waited ${waitedMs}ms for a dispatch slot`);

    applyFastModeHeaders(event.headers, { provider: ctx.model?.provider, speed: s.speed });

    if (!s.signing) return;
    await applyZcodeSigningHeaders(event.headers, {
      provider: ctx.model?.provider,
      // The settings layer already folded ZAI_ANTHROPIC_SIGNING in, so the raw
      // env must not re-decide — `env: {}` keeps that switch single-sourced.
      env: {},
      baseUrl: s.baseUrl,
      sessionId:
        typeof ctx.sessionManager?.getSessionId === "function" ? ctx.sessionManager.getSessionId() : undefined,
      credential: signingCredential(event.headers),
    });
  });

  // 401 ladder for the signing state: any 401 right after a signed request
  // invalidates the handshake key (status-only approximation — the hook has no
  // body), two consecutive → bypass for the process; any success resets the count.
  pi.on("after_provider_response", (event, ctx) => {
    if (!isZaiAnthropicProvider(ctx.model?.provider)) return;
    if (!settingsFor(ctx).signing) return;
    if (event.status === 401) getZcodeSigningManager().noteResponse401();
    else getZcodeSigningManager().noteResponseOk();
  });

  pi.registerCommand("zai", {
    description: "Show Z.AI Coding Plan (zai-anthropic) status: endpoint, speed, signing, dispatch gate, key.",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const s = getZaiSettings({ cwd: ctx.cwd, trusted: ctx.isProjectTrusted?.() === true });
      const lines = statusLines(s, registeredBaseUrl);
      if (args.trim()) lines.push("", "Usage: /zai  (status) — change these in /config → Providers → Z.AI.");
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
