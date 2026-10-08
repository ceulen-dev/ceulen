// ponytail: vendored from @bacnh85/pi-web 0.17.8
// Unified search orchestrator.
// Probes backend availability and adaptively tries backends:
//   SearXNG (self-hosted) for broad discovery,
//   Brave (hosted API) for precision/inline content,
//   Firecrawl as last-resort search.

import { findEnvValue, cwdFromContext, includeProjectEnv, normalizeSearxngBaseUrl } from "./config";
import { fetchBraveResults } from "./brave";
import { fetchSearxngResults } from "./searxng";
import { firecrawlRequest, type FirecrawlResult } from "./firecrawl";
import { loadFirecrawlConfig, loadSearxngConfig, type FirecrawlConfig } from "./config";
import { fetchReadableContent } from "./content";
import { sanitizeSnippet, sanitizeError } from "./format";
import { askJev, getLastTask } from "../../classifier/index.js";

export type SearchBackend = "searxng" | "brave" | "firecrawl";
export type SearchAttemptStatus = "skipped" | "success" | "empty" | "error";

export interface SearchParams {
  query: string;
  count?: number;
  freshness?: string;
  country?: string;
  backend?: "auto" | SearchBackend;
  engines?: string;
  include_content?: boolean;
  content_chars?: number;
  timeout_ms?: number;
  signal?: AbortSignal;
  /** Internal: caller-provided ctx for env lookup. */
  _ctx?: Record<string, unknown>;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  age: string;
  content: string;
  backend: string;
}

export interface SearchAttempt {
  backend: SearchBackend;
  status: SearchAttemptStatus;
  message: string;
  resultCount: number;
}

export interface SearchDiagnostics {
  results: SearchResult[];
  attempts: SearchAttempt[];
  selectedBackend: SearchBackend | "";
  backendOrder: SearchBackend[];
  /** How the backend order was picked: an explicit backend/engines param, the
   *  isPrecisionQuery heuristic, or the classifier's verdict. */
  router: "explicit" | "heuristic" | "classifier:jev";
}

interface BackendConfig {
  searxng: { configured: boolean; baseUrl: string };
  brave: { configured: boolean; apiKey: string };
  firecrawl: { configured: boolean; config: FirecrawlConfig | null };
}

function probeBackends(ctx?: Record<string, unknown>): BackendConfig {
  const cwd = cwdFromContext(ctx ?? {});
  const trusted = includeProjectEnv(ctx ?? {});

  let searxngBaseUrl: string;
  try {
    const searxngConfig = loadSearxngConfig({}, cwd, trusted);
    searxngBaseUrl = searxngConfig.baseUrl;
  } catch {
    searxngBaseUrl = normalizeSearxngBaseUrl();
  }

  const braveKey = findEnvValue("BRAVE_API_KEY", cwd, trusted);

  let fcConfig: FirecrawlConfig | null = null;
  try {
    fcConfig = loadFirecrawlConfig({}, cwd, trusted);
  } catch {
    // Not configured or unsafe to use from this context.
  }

  return {
    searxng: { configured: true, baseUrl: searxngBaseUrl },
    brave: { configured: Boolean(braveKey.value), apiKey: braveKey.value ?? "" },
    firecrawl: { configured: fcConfig !== null, config: fcConfig },
  };
}

async function searchSearxng(params: SearchParams): Promise<SearchResult[]> {
  const cfg = loadSearxngConfig(
    { ...(params.engines ? { engines: params.engines } : {}) } as Record<string, unknown>,
    cwdFromContext(params._ctx ?? {}),
    includeProjectEnv(params._ctx ?? {}),
  );
  // freshness pw/pm/py maps to SearXNG time_range; explicit date ranges stay
  // Brave-only (SearXNG has no date-interval param) and are dropped here.
  const timeRange = params.freshness === "pw" || params.freshness === "pm" || params.freshness === "py" ? params.freshness : undefined;
  const raw = await fetchSearxngResults(
    { query: params.query, count: params.count ?? 5, engines: params.engines, time_range: timeRange, timeout_ms: params.timeout_ms } as Record<string, unknown>,
    cfg.baseUrl,
    params.signal,
  );
  return (raw.results || []).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: r.snippet ?? "",
    age: r.publishedDate ?? "",
    content: "",
    backend: "searxng",
  }));
}

async function searchBrave(params: SearchParams, backends: BackendConfig): Promise<SearchResult[]> {
  if (!backends.brave.configured) throw new Error("Brave not configured (no BRAVE_API_KEY)");
  const raw = await fetchBraveResults(
    params.query,
    params.count ?? 5,
    params.country ?? "US",
    params.freshness ?? "",
    backends.brave.apiKey,
    params.signal,
  );
  const results = raw.map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: r.snippet ?? "",
    age: r.age ?? "",
    content: "",
    backend: "brave",
  }));
  if (params.include_content && results.length > 0) {
    const maxChars = params.content_chars ?? 5000;
    // Cap concurrent content fetches to avoid OOM from parallel JSDOM parsing
    const MAX_CONCURRENT_FETCHES = 5;
    const batchSize = Math.min(results.length, MAX_CONCURRENT_FETCHES);
    for (let i = 0; i < results.length; i += batchSize) {
      const batch = results.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async (r) => {
          try {
            const article = await fetchReadableContent(r.url, params.timeout_ms ?? 10000, params.signal);
            r.content = article.markdown.slice(0, maxChars);
          } catch (e: any) {
            r.content = `(Fetch error for ${r.url}: ${sanitizeError(e)})`;
          }
        }),
      );
    }
  }
  return results;
}

async function searchFirecrawl(params: SearchParams, backends: BackendConfig): Promise<SearchResult[]> {
  if (!backends.firecrawl.configured || !backends.firecrawl.config) {
    throw new Error("Firecrawl not configured (no FIRECRAWL_API_URL)");
  }
  const body: Record<string, unknown> = {
    query: params.query,
    limit: Math.min(100, Math.max(1, params.count ?? 5)),
    sources: [{ type: "web" }],
    ...(params.country ? { country: String(params.country).toUpperCase() } : {}),
  };
  const result = await firecrawlRequest(backends.firecrawl.config, "POST", "/search", body, params.signal) as FirecrawlResult;
  const rootData = result.data as Record<string, unknown> | undefined;
  const web = (rootData?.web as unknown[]) || [];
  const news = (rootData?.news as unknown[]) || [];
  const items = [...web, ...news];
  return items.map((r: any) => ({
    title: sanitizeSnippet(r.title ?? r.metadata?.title ?? ""),
    url: r.url ?? r.metadata?.sourceURL ?? "",
    snippet: sanitizeSnippet(r.description ?? r.snippet ?? ""),
    age: "",
    content: r.markdown ? String(r.markdown).slice(0, params.content_chars ?? 5000) : "",
    backend: "firecrawl",
  }));
}

function isPrecisionQuery(params: SearchParams): boolean {
  const query = params.query.trim();
  const lower = query.toLowerCase();
  if (params.include_content) return true;
  if (/\bsite:[^\s]+/i.test(query)) return true;
  if (/"[^"]+"/.test(query)) return true;
  if (/\b(docs?|documentation|api|github|repo|repository|changelog|release|issue|bug|sdk|package)\b/i.test(query)) return true;
  const terms = query.split(/\s+/).filter(Boolean);
  if (terms.length > 0 && terms.length <= 4 && /\b[A-Z][A-Za-z0-9_-]{2,}\b/.test(query)) return true;
  if (/\b[a-z0-9-]+\.(com|dev|io|org|net|app|ai|tv)\b/i.test(lower)) return true;
  return false;
}

export function selectSearchBackendOrder(params: SearchParams): SearchBackend[] {
  if (params.backend && params.backend !== "auto") return [params.backend];
  if (params.engines && !params.include_content) return ["searxng", "brave", "firecrawl"];
  if (isPrecisionQuery(params)) return ["brave", "searxng", "firecrawl"];
  return ["searxng", "brave", "firecrawl"];
}

// ── Classifier-routed order (auto mode only) ────────────────────────────────

const CLASSIFIER_ORDER_BUDGET_MS = 2_500; // ponytail: value of classifier's CLASSIFIER_HOOK_BUDGET_MS — module-private state is not imported
const CLASSIFIER_MIN_CONFIDENCE = 0.6;
const PRECISION_ORDER: SearchBackend[] = ["brave", "searxng", "firecrawl"];
const BROAD_ORDER: SearchBackend[] = ["searxng", "brave", "firecrawl"];

/** LRU over query fingerprints — repeated queries must not re-pay Jev.
 *  ponytail: insertion-order map, cap 200. Value: the resolved order. */
const orderCache = new Map<string, { order: SearchBackend[]; router: "classifier:jev" | "heuristic" }>();

function fingerprint(query: string): string {
  return query.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
}

/** Read a choice answer defensively: probabilities[choice], else confidence.
 *  Anything missing/out-of-range → NaN → the caller falls back. */
function choiceConfidence(answer: unknown): number {
  const a = answer && typeof answer === "object" ? (answer as Record<string, unknown>) : {};
  const p = a.probabilities && typeof a.probabilities === "object" ? (a.probabilities as Record<string, unknown>)[String(a.choice)] : undefined;
  const v = typeof p === "number" ? p : a.confidence;
  return typeof v === "number" && v >= 0 && v <= 1 ? v : NaN;
}

function readNoul(answer: unknown): number {
  const a = answer && typeof answer === "object" ? (answer as Record<string, unknown>) : {};
  const v = typeof a.probability === "number" ? a.probability : a.noul;
  return typeof v === "number" && v >= 0 && v <= 1 ? v : NaN;
}

/** One Jev round-trip picks brave-first vs searxng-first; a wrong pick costs
 *  one probe + fallback, never a wrong answer. Low confidence, timeout, or
 *  any failure → the isPrecisionQuery heuristic, unchanged. */
async function classifyOrder(params: SearchParams): Promise<{ order: SearchBackend[]; router: "classifier:jev" | "heuristic" }> {
  const fp = fingerprint(params.query);
  const cached = orderCache.get(fp);
  if (cached) {
    orderCache.delete(fp);
    orderCache.set(fp, cached);
    return cached;
  }
  const ctx = params._ctx as Parameters<typeof askJev>[0] | undefined;
  let resolved: { order: SearchBackend[]; router: "classifier:jev" | "heuristic" } | undefined;
  try {
    if (ctx && typeof ctx.modelRegistry?.classify === "function") {
      const task = getLastTask();
      const state: Record<string, unknown> = { query: params.query };
      const questions: Record<string, unknown> = {
        backend_preference: {
          type: "choice",
          instructions: "Which search backend should try this web query first?",
          criteria: {
            brave_first: "Precision lookup — site/docs/API/error-string search, freshness windows, or inline page content needed.",
            searxng_first: "Broad multi-engine discovery, ambiguous topic exploration, or general browsing.",
          },
        },
        ...(params.include_content === undefined
          ? { include_content: { type: "bool", instructions: "Would answering this query benefit from fetching the full page content of results (vs snippets alone)?" } }
          : {}),
        ...(task ? { serves_task: { type: "bool", instructions: "Does this query plausibly serve the user's current task?", criteria: { yes: "A reasonable search toward the task.", no: "Unrelated to the task." } } } : {}),
      };
      const budget = AbortSignal.timeout(CLASSIFIER_ORDER_BUDGET_MS);
      const answers = (await Promise.race([
        askJev(ctx, state, questions, budget),
        new Promise<never>((_, reject) => budget.addEventListener("abort", () => reject(new Error("classifier budget exceeded")), { once: true })),
      ])) as Record<string, unknown>;
      const pref = answers.backend_preference as Record<string, unknown> | undefined;
      const choice = String(pref?.choice ?? "");
      const confidence = choiceConfidence(pref);
      const contentNeeded = params.include_content === undefined && Number.isFinite(readNoul(answers.include_content))
        ? readNoul(answers.include_content) >= 0.5
        : false;
      const servesOk = !answers.serves_task || readNoul(answers.serves_task) >= 0.5;
      if (servesOk && Number.isFinite(confidence) && confidence >= CLASSIFIER_MIN_CONFIDENCE && (choice === "brave_first" || choice === "searxng_first")) {
        // include_content influences ORDER only — never turned into a fetch
        // (a classifier guess must not trigger N page downloads).
        const order = choice === "brave_first" || contentNeeded ? PRECISION_ORDER : BROAD_ORDER;
        resolved = { order, router: "classifier:jev" };
      }
    }
  } catch {
    resolved = undefined; // fail open to the heuristic
  }
  if (!resolved) resolved = { order: selectSearchBackendOrder(params), router: "heuristic" };
  orderCache.set(fp, resolved);
  if (orderCache.size > 200) orderCache.delete(orderCache.keys().next().value!);
  return resolved;
}

/** The order searchWithDiagnostics executes: explicit params keep the legacy
 *  sync path (router: explicit); auto mode asks the classifier when ≥2
 *  backends are configured and falls back to the heuristic otherwise. */
async function resolveBackendOrder(params: SearchParams, backends: BackendConfig): Promise<{ order: SearchBackend[]; router: SearchDiagnostics["router"] }> {
  if ((params.backend && params.backend !== "auto") || params.engines) {
    return { order: selectSearchBackendOrder(params), router: "explicit" };
  }
  const configured = (["searxng", "brave", "firecrawl"] as SearchBackend[]).filter((b) => isConfigured(b, backends)).length;
  if (configured < 2) {
    return { order: selectSearchBackendOrder(params), router: "heuristic" };
  }
  const classified = await classifyOrder(params);
  return classified;
}

function isConfigured(backend: SearchBackend, backends: BackendConfig): boolean {
  if (backend === "searxng") return backends.searxng.configured;
  if (backend === "brave") return backends.brave.configured;
  return backends.firecrawl.configured;
}

async function runBackend(backend: SearchBackend, params: SearchParams, backends: BackendConfig): Promise<SearchResult[]> {
  if (backend === "searxng") return searchSearxng(params);
  if (backend === "brave") return searchBrave(params, backends);
  return searchFirecrawl(params, backends);
}

export async function searchWithDiagnostics(params: SearchParams): Promise<SearchDiagnostics> {
  const backends = probeBackends(params._ctx);
  const { order: backendOrder, router } = await resolveBackendOrder(params, backends);
  const attempts: SearchAttempt[] = [];

  for (const backend of backendOrder) {
    if (!isConfigured(backend, backends)) {
      attempts.push({ backend, status: "skipped", message: `${backend} is not configured`, resultCount: 0 });
      continue;
    }
    try {
      const results = await runBackend(backend, params, backends);
      if (results.length > 0) {
        attempts.push({ backend, status: "success", message: `Selected ${backend}`, resultCount: results.length });
        return { results, attempts, selectedBackend: backend, backendOrder, router };
      }
      attempts.push({ backend, status: "empty", message: `${backend} returned 0 results`, resultCount: 0 });
    } catch (e) {
      attempts.push({ backend, status: "error", message: sanitizeError(e), resultCount: 0 });
      if (params.backend && params.backend !== "auto") break;
    }
  }

  return { results: [], attempts, selectedBackend: "" as const, backendOrder, router };
}

