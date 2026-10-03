// ponytail: vendored from @bacnh85/pi-web 0.17.8
// Local delta: the dotenv file-walking (findEnvValue's cwd/agent-dir .env*
// parsing) is DELETED — ceulen's bundle env.ts already ingests agent-dir +
// trusted-cwd .env* into process.env, so process.env IS the full env chain.
// findEnvValue keeps its name/shape but resolves env → settings.json (`web`
// section: trusted project > global, see lib/settings.ts) → unset.

import { lookupVar } from "./settings";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const HOSTED_FIRECRAWL_BASE_URL = "https://api.firecrawl.dev/v2";
export const DEFAULT_SEARXNG_BASE_URL = "http://127.0.0.1:8888";
export const DEFAULT_CRAWL4AI_API_URL = "http://127.0.0.1:11235";

// ---------------------------------------------------------------------------
// Environment + settings resolution
// ---------------------------------------------------------------------------

export function findEnvValue(name: string, cwd = process.cwd(), includeCwd = true): { value?: string; source: string } {
  return lookupVar(name, cwd, includeCwd);
}

// ---------------------------------------------------------------------------
// Context helpers
// ---------------------------------------------------------------------------

export function cwdFromContext(ctx: Record<string, unknown>): string {
  return typeof ctx?.cwd === "string" && (ctx.cwd as string) ? (ctx.cwd as string) : process.cwd();
}

export function includeProjectEnv(ctx: Record<string, unknown>): boolean {
  return typeof ctx?.isProjectTrusted === "function" ? (ctx.isProjectTrusted as () => boolean)() : false;
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

function normalizeHttpUrl(raw: string | undefined, fallback: string): string {
  let value = (raw || fallback).trim();
  if (!/^https?:\/\//i.test(value)) {
    value = /^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/i.test(value)
      ? `http://${value}`
      : `https://${value}`;
  }
  return value.replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// SearXNG config
// ---------------------------------------------------------------------------

export interface SearxngConfig {
  baseUrl: string;
  source: string;
}

export function normalizeSearxngBaseUrl(raw?: string): string {
  return normalizeHttpUrl(raw, DEFAULT_SEARXNG_BASE_URL);
}

export function loadSearxngConfig(params: Record<string, unknown> = {}, cwd = process.cwd(), includeCwdEnv = false): SearxngConfig {
  const baseUrlEnv = findEnvValue("SEARXNG_BASE_URL", cwd, includeCwdEnv);
  const explicitBaseUrl = params.searxng_base_url as string | undefined;
  const baseUrl = normalizeSearxngBaseUrl(explicitBaseUrl || (params.base_url as string) || baseUrlEnv.value);
  const source = explicitBaseUrl || params.base_url ? "tool parameter" : baseUrlEnv.source || "default local";
  return { baseUrl, source };
}

// ---------------------------------------------------------------------------
// Crawl4AI config
// ---------------------------------------------------------------------------

export interface Crawl4aiConfig {
  baseUrl: string;
  apiToken: string;
  timeoutMs: number;
}

export function normalizeCrawl4aiApiUrl(raw?: string): string {
  return normalizeHttpUrl(raw, DEFAULT_CRAWL4AI_API_URL);
}

export function loadCrawl4aiConfig(params: Record<string, unknown> = {}, cwd = process.cwd(), includeCwdEnv = false): Crawl4aiConfig {
  const apiUrlLookup = findEnvValue("CRAWL4AI_API_URL", cwd, includeCwdEnv);
  const apiTokenLookup = findEnvValue("CRAWL4AI_API_TOKEN", cwd, includeCwdEnv);
  const explicitApiUrl = params.crawl4ai_api_url as string | undefined;
  const explicitApiToken = params.crawl4ai_api_token as string | undefined;
  const baseUrl = normalizeCrawl4aiApiUrl(explicitApiUrl || apiUrlLookup.value);
  // Security: only use env-var API token when URL is default or also from env var.
  // If the URL is overridden via params but no explicit token was provided, don't send
  // the env-var token to a potentially attacker-controlled URL.
  const apiToken = explicitApiToken || (explicitApiUrl ? "" : apiTokenLookup.value) || "";
  const timeoutValue = (params.timeout_ms as number) || findEnvValue("CRAWL4AI_API_TIMEOUT_MS", cwd, includeCwdEnv).value;
  const timeoutMs = timeoutValue ? Number.parseInt(String(timeoutValue), 10) : 60000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000) throw new Error("CRAWL4AI_API_TIMEOUT_MS/timeout_ms must be an integer >= 1000.");
  return { baseUrl, apiToken, timeoutMs };
}

// ---------------------------------------------------------------------------
// Firecrawl config
// ---------------------------------------------------------------------------

export interface FirecrawlConfig {
  baseUrl: string;
  apiKey: string;
  isHosted: boolean;
  timeoutMs: number;
}

export function normalizeFirecrawlBaseUrl(raw?: string): string {
  let value = normalizeHttpUrl(raw, HOSTED_FIRECRAWL_BASE_URL);
  if (!/\/v\d+$/i.test(value)) value += "/v2";
  return value;
}

export function loadFirecrawlConfig(params: Record<string, unknown> = {}, cwd = process.cwd(), includeCwdEnv = false): FirecrawlConfig {
  const apiUrlLookup = findEnvValue("FIRECRAWL_API_URL", cwd, includeCwdEnv);
  const apiKeyLookup = findEnvValue("FIRECRAWL_API_KEY", cwd, includeCwdEnv);
  const explicitApiKey = (params.firecrawl_api_key as string) || (params.api_key as string);
  const apiUrl = (params.firecrawl_api_url as string) || (params.api_url as string) || apiUrlLookup.value;
  // Security: only use env-var API key when URL is default or also from env var.
  // If the URL is overridden via params but no explicit key was provided, don't send
  // the env-var key to a potentially attacker-controlled URL.
  const apiKey = explicitApiKey || (apiUrl !== apiUrlLookup.value && apiUrl ? "" : apiKeyLookup.value) || "";
  const timeoutValue = (params.timeout_ms as number) || findEnvValue("FIRECRAWL_TIMEOUT_MS", cwd, includeCwdEnv).value;
  const baseUrl = normalizeFirecrawlBaseUrl(apiUrl);
  const isHosted = !apiUrl || baseUrl.startsWith(HOSTED_FIRECRAWL_BASE_URL);
  const timeoutMs = timeoutValue ? Number.parseInt(String(timeoutValue), 10) : 60000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000) throw new Error("FIRECRAWL_TIMEOUT_MS/timeout_ms must be an integer >= 1000.");
  if (isHosted && !apiKey) throw new Error("FIRECRAWL_API_KEY is required for hosted Firecrawl.");
  return { baseUrl, apiKey, isHosted, timeoutMs };
}
