// ponytail: vendored from @kalera/munin-sdk 1.5.0 (dist/{client,errors,capabilities}.js +
// types.d.ts) — 152 lines, zero deps, so the bundle keeps its no-runtime-deps rule.
// Local changes vs upstream: capabilities cache is keyed by `${baseUrl}|${apiKey}`
// (upstream cached one global `globalThis.__munin_caps`, which went stale when a
// user switched munin servers per project), and fetchCapabilities arms a timeout
// like invoke() (upstream could hang forever on a dead server).
// Upgrade = re-vendor this one file.

export type MuninAction = "store" | "retrieve" | "search" | "list" | "recent" | "share" | "versions" | "rollback" | "encrypt" | "decrypt" | "diff" | "delete" | "acknowledge_setup";

export interface MuninActionEnvelope<TPayload = Record<string, unknown>> {
  action: MuninAction;
  project: string;
  payload: TPayload;
  requestId?: string;
  client?: {
    name: string;
    version: string;
  };
}

export interface MuninCapabilities {
  specVersion: string;
  actions: {
    core: string[];
    optional: string[];
  };
  features: Record<string, {
    supported: boolean;
    reason?: string;
  }>;
  metadata: {
    serverVersion: string;
    timestamp: string;
    [key: string]: unknown;
  };
}

export interface MuninError {
  code: "AUTH_INVALID" | "FEATURE_DISABLED" | "NOT_FOUND" | "RATE_LIMITED" | "VALIDATION_ERROR" | "INTERNAL_ERROR" | "ERR_STALE_PROTOCOL";
  message: string;
  details?: Record<string, unknown>;
}

export interface MuninResponse<TData = unknown> {
  ok: boolean;
  data?: TData;
  error?: MuninError;
  requestId?: string;
}

export interface MuninClientConfig {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class MuninSdkError extends Error {
  code: MuninError["code"] | string;
  details?: Record<string, unknown>;
  constructor(error: MuninError) {
    super(error.message);
    this.name = "MuninSdkError";
    this.code = error.code;
    this.details = error.details;
  }
}

export class MuninTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MuninTransportError";
  }
}

export async function fetchCapabilities(baseUrl: string, apiKey: string | undefined, fetchImpl: typeof fetch = fetch, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<MuninCapabilities> {
  const response = await fetchImpl(`${baseUrl}/api/mcp/capabilities`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((error) => {
    throw new MuninTransportError(`Failed to call capabilities endpoint: ${String(error)}`);
  });
  if (!response.ok) {
    throw new MuninTransportError(`Capabilities request failed with status ${response.status}`);
  }
  const body = (await response.json()) as MuninResponse<MuninCapabilities>;
  if (!body.ok || !body.data) {
    throw new MuninSdkError(body.error ?? {
      code: "INTERNAL_ERROR",
      message: "Capabilities response missing data",
    });
  }
  return body.data;
}

export function isActionSupported(capabilities: MuninCapabilities, action: string): boolean {
  return capabilities.actions.core.includes(action) ||
    capabilities.actions.optional.includes(action);
}

const DEFAULT_TIMEOUT_MS = 15_000;

export class MuninClient {
  baseUrl: string;
  apiKey: string | undefined;
  timeoutMs: number;
  fetchImpl: typeof fetch;
  constructor(config?: MuninClientConfig) {
    this.baseUrl = (config?.baseUrl || "https://munin.kalera.dev").replace(/\/$/, "");
    this.apiKey = config?.apiKey;
    this.timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config?.fetchImpl ?? fetch;
  }

  async capabilities(forceRefresh = false): Promise<MuninCapabilities> {
    const cacheKey = `${this.baseUrl}|${this.apiKey ?? ""}`;
    if (!forceRefresh && globalThis.__munin_caps?.key === cacheKey) {
      return globalThis.__munin_caps.caps;
    }
    const caps = await fetchCapabilities(this.baseUrl, this.apiKey, this.fetchImpl, this.timeoutMs);
    globalThis.__munin_caps = { key: cacheKey, caps };
    return caps;
  }

  async invoke(projectId: string, action: string, payload: Record<string, unknown> = {}, options?: { ensureCapability?: boolean; requestId?: string }): Promise<unknown> {
    if (options?.ensureCapability) {
      const caps = await this.capabilities();
      if (!isActionSupported(caps, action)) {
        throw new MuninSdkError({
          code: "FEATURE_DISABLED",
          message: `Action '${action}' is not supported by current server capabilities`,
        });
      }
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const response = await this.fetchImpl(`${this.baseUrl}/api/mcp/action`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        apiKey: this.apiKey,
        project: projectId,
        projectId, // Fallback for un-restarted server
        action,
        payload,
        requestId: options?.requestId,
        client: {
          name: "@kalera/munin-sdk",
          version: "1.5.0",
        },
      }),
      signal: controller.signal,
    }).catch((error) => {
      clearTimeout(timeout);
      throw new MuninTransportError(`Request failed for action '${action}': ${String(error)}`);
    });
    clearTimeout(timeout);
    const body = (await response.json()) as MuninResponse & { success?: boolean };
    if (!response.ok || (body.ok === false) || (body.success === false)) {
      let errObj: MuninError | undefined = body.error;
      if (typeof errObj === "string") {
        // The server may return `error` as a bare string code
        // (e.g. "ERR_STALE_PROTOCOL"); use it as both the code and message
        // instead of flattening every string error into INTERNAL_ERROR.
        errObj = { code: errObj as MuninError["code"], message: errObj };
      }
      if (!errObj) {
        errObj = {
          code: "INTERNAL_ERROR",
          message: `Unexpected failure invoking action '${action}'`,
        };
      }
      // A top-level `remediation` (sent alongside the error envelope, e.g. for
      // ERR_STALE_PROTOCOL) is folded into `details` so callers can read it via
      // MuninSdkError.details without losing any existing structured details.
      const remediation = (body as { remediation?: unknown }).remediation;
      if (remediation !== undefined) {
        errObj = {
          ...errObj,
          details: { ...(errObj.details ?? {}), remediation },
        };
      }
      throw new MuninSdkError(errObj);
    }
    return body;
  }

  async store(projectId: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    return this.invoke(projectId, "store", payload, { ensureCapability: true });
  }
  async retrieve(projectId: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    return this.invoke(projectId, "retrieve", payload, { ensureCapability: true });
  }
  async search(projectId: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    return this.invoke(projectId, "search", payload, { ensureCapability: true });
  }
  async list(projectId: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    return this.invoke(projectId, "list", payload, { ensureCapability: true });
  }
  async recent(projectId: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    return this.invoke(projectId, "recent", payload, { ensureCapability: true });
  }
  async share(projectId: string, memoryIds: string[], targetProjectIds: string[]): Promise<unknown> {
    return this.invoke(projectId, "share", { memoryIds, targetProjectIds }, { ensureCapability: true });
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __munin_caps: { key: string; caps: MuninCapabilities } | undefined;
}
