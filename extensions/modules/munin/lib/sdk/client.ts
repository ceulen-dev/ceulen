// ponytail: vendored from @kalera/munin-sdk 1.6.0 (dist/client.js + client.d.ts).
// Local deltas marked `// ponytail (local delta):` below.

import { MuninMaintenanceError, MuninSdkError, MuninTransportError, type MaintenanceReason } from "./errors.js";
import { fetchCapabilities, isActionSupported } from "./capabilities.js";
import {
  DEFAULT_MAINTENANCE_RETRY,
  isDeleteAction,
  isGatewayResponse,
  isMaintenanceResponse,
  isWriteAction,
  keyFingerprint,
  maintenanceDelayMs,
  retryAfterMs,
  stripSecrets,
  type MaintenanceRetryPolicy,
} from "./maintenance.js";
import {
  EMPTY_DRAIN_REPORT,
  inFailureBackoff,
  type DrainReport,
  type DrainVerdict,
  type PendingWrite,
  type PendingWriteQueue,
} from "./writeQueue.js";
import type { MuninAction, MuninCapabilities, MuninClientConfig, MuninError } from "./types.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_FLUSH_BEFORE_WRITE_MS = 5_000;

// ponytail (local delta 3): exported so the vendored version and the write-gate
// comparison can be asserted by tests — the incident was an envelope that
// advertised a version nothing compared.
export const CLIENT_VERSION = "1.6.0";

/** The client name the server's `clients` gate keys on. */
const CLIENT_NAME = "@kalera/munin-sdk";

/** Numeric-segment compare: >0 when a is newer, <0 when b is newer, 0 when equal.
 *  Missing/malformed segments count as 0, so a junk minimum fails open. */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = Number.parseInt(pa[i] ?? "0", 10);
    const nb = Number.parseInt(pb[i] ?? "0", 10);
    const diff = (Number.isFinite(na) ? na : 0) - (Number.isFinite(nb) ? nb : 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * ponytail (local delta 4): refuse a write the server will reject anyway, with a
 * message naming ceulen (the SDK is vendored, so "install the npm package" is
 * wrong advice). Missing/malformed `minimum` fails open — the server stays
 * authoritative.
 */
function ensureWritableClientVersion(caps: MuninCapabilities): void {
  const minimum = caps.clients?.[CLIENT_NAME]?.minimum;
  if (!minimum || typeof minimum !== "string") return;
  if (compareVersions(CLIENT_VERSION, minimum) >= 0) return;
  throw new MuninSdkError({
    code: "ERR_CLIENT_OUTDATED",
    message: `Munin client ${CLIENT_NAME} ${CLIENT_VERSION} is too old to write to this server (minimum ${minimum}). This write was NOT saved.`,
  });
}

const isNode = (): boolean => typeof process !== "undefined" && Boolean(process.versions?.node);

type Reply = {
  ok: boolean;
  status: number;
  body: any;
  jsonBody: boolean;
  maintenance: boolean;
  retryAfterMs: number | null;
};

/** How a replayed write's answer moves the queue (see DrainVerdict). */
function replayVerdict(reply: Reply, action: string): DrainVerdict {
  if (reply.ok) return "done";
  if (reply.maintenance) return "stop"; // waits for the window to end, without limit
  if (isGatewayResponse(reply.status, reply.jsonBody)) return "stop"; // proxy outage: like offline
  if (reply.status === 404 && isDeleteAction(action)) return "done"; // already gone
  if (reply.status >= 500 || reply.status === 429 || reply.status === 408) return "fail"; // counted, bounded
  return "dead";
}

function toSdkError(body: any, action: string): MuninSdkError {
  let errObj: MuninError | undefined = body?.error;
  if (typeof errObj === "string") {
    // The server may return `error` as a bare string code (e.g. "ERR_STALE_PROTOCOL").
    errObj = { code: errObj as MuninError["code"], message: errObj as unknown as string };
  }
  if (!errObj) {
    errObj = { code: "INTERNAL_ERROR", message: `Unexpected failure invoking action '${action}'` };
  }
  // A top-level `remediation` (e.g. ERR_STALE_PROTOCOL) is folded into `details`.
  if (body?.remediation !== undefined) {
    errObj = { ...errObj, details: { ...(errObj.details ?? {}), remediation: body.remediation } };
  }
  return new MuninSdkError(errObj);
}

export class MuninClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly retryPolicy: MaintenanceRetryPolicy;
  private readonly flushBeforeWriteMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly writeQueueOption: PendingWriteQueue | false | undefined;
  private readonly rehydratePayload?: (payload: Record<string, unknown>, strippedKeys: string[]) => Record<string, unknown> | null;
  private defaultQueue?: Promise<PendingWriteQueue>;
  private flushing: Promise<DrainReport> | null = null;
  /** Entries dead-lettered by this client's flushes since takeDeadLetterCount() last ran. */
  private deadLettered = 0;
  /** Deadline (epoch ms) of the running flush; a later caller may only tighten it. */
  private flushDeadline: number | undefined;

  constructor(config?: MuninClientConfig) {
    this.baseUrl = (config?.baseUrl || "https://munin.kalera.dev").replace(/\/$/, "");
    this.apiKey = config?.apiKey;
    this.timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config?.fetchImpl ?? fetch;
    this.retryPolicy = { ...DEFAULT_MAINTENANCE_RETRY, ...(config?.maintenanceRetry ?? {}) };
    this.flushBeforeWriteMs = config?.flushBeforeWriteMs ?? DEFAULT_FLUSH_BEFORE_WRITE_MS;
    this.sleep = config?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.writeQueueOption = config?.writeQueue;
    this.rehydratePayload = config?.rehydratePayload;
  }

  async capabilities(forceRefresh = false): Promise<MuninCapabilities> {
    // ponytail (local delta 1): the cache is keyed by endpoint+key. Upstream
    // stored one un-keyed global, so a session that switched munin servers (or
    // API keys) read the OTHER server's capabilities — and so its write gate.
    // Single slot on purpose: two keys in flight is rare, and the cost of an
    // eviction is one extra GET.
    const cacheKey = `${this.baseUrl}|${this.apiKey ?? ""}`;
    if (!forceRefresh && globalThis.__munin_caps?.key === cacheKey) {
      return globalThis.__munin_caps.caps;
    }
    const caps = await fetchCapabilities(this.baseUrl, this.apiKey, this.fetchImpl, this.timeoutMs);
    globalThis.__munin_caps = { key: cacheKey, caps };
    return caps;
  }

  async invoke<TPayload extends Record<string, unknown>>(
    projectId: string,
    action: MuninAction,
    payload: TPayload,
    options?: { requestId?: string; ensureCapability?: boolean },
  ): Promise<any> {
    if (options?.ensureCapability) {
      const caps = await this.capabilities();
      if (!isActionSupported(caps, action)) {
        throw new MuninSdkError({
          code: "FEATURE_DISABLED",
          message: `Action '${action}' is not supported by current server capabilities`,
        });
      }
      // ponytail (local delta 4): pre-write version gate, AFTER the capability check.
      if (isWriteAction(action)) ensureWritableClientVersion(caps);
    } else if (isWriteAction(action)) {
      // ponytail (local delta 4): the capability check is skippable (delete and
      // acknowledge_setup are real actions the server does not advertise), but
      // the WRITE GATE is not — an unadvertised write is still a write. Delta 1
      // keys the cache, so this costs no extra GET once capabilities are warm.
      ensureWritableClientVersion(await this.capabilities());
    }
    // A write never overtakes an older queued write: send the queue first, and
    // if something of this project is still waiting, queue behind it.
    if (isWriteAction(action) && !(await this.flushBeforeWrite(projectId))) {
      return this.onMaintenance(projectId, action, payload, null, "pending");
    }
    let reply = await this.sendOnce(projectId, action, payload, options?.requestId);
    for (let attempt = 0; reply.maintenance && attempt < this.retryPolicy.retries; attempt++) {
      await this.sleep(maintenanceDelayMs(attempt, reply.retryAfterMs, this.retryPolicy));
      reply = await this.sendOnce(projectId, action, payload, options?.requestId);
    }
    if (reply.maintenance) return this.onMaintenance(projectId, action, payload, reply.retryAfterMs);
    if (!reply.ok) throw toSdkError(reply.body, action);
    // Munin accepts calls again: send anything a maintenance window left behind.
    void this.flushPendingWrites().catch(() => undefined);
    return reply.body;
  }

  /**
   * Sends queued writes in order. Single-flight per client; safe to call at
   * process start. With a deadline (epoch ms), entries not yet sent when it
   * passes stay queued, in order (an in-flight request still completes). A
   * deadline given while a flush is running tightens that flush, so no caller
   * waits longer than its own deadline plus one request.
   */
  async flushPendingWrites(deadlineMs?: number): Promise<DrainReport> {
    if (this.flushing) {
      if (deadlineMs !== undefined) this.flushDeadline = Math.min(this.flushDeadline ?? Infinity, deadlineMs);
      return this.flushing;
    }
    this.flushDeadline = deadlineMs;
    this.flushing = this.drainQueue().finally(() => {
      this.flushing = null;
      this.flushDeadline = undefined;
    });
    return this.flushing;
  }

  /** How many queued writes this client's flushes dead-lettered since the last call; resets to 0. */
  takeDeadLetterCount(): number {
    const count = this.deadLettered;
    this.deadLettered = 0;
    return count;
  }

  /**
   * Before a write: wait for a flush already running, then flush with a
   * deadline. True when nothing of this client for this project is still
   * queued, i.e. the new write cannot overtake an older store or delete.
   * Bounded by flushBeforeWriteMs plus at most one request timeout.
   */
  private async flushBeforeWrite(projectId: string): Promise<boolean> {
    const queue = await this.resolveQueue();
    if (!queue) return true;
    const deadline = Date.now() + this.flushBeforeWriteMs;
    // A flush already running is tightened to this deadline and awaited; then
    // one pass of our own, which stops at once if the deadline has passed.
    const wasFlushing = this.flushing !== null;
    await this.flushPendingWrites(deadline).catch(() => undefined);
    if (wasFlushing) await this.flushPendingWrites(deadline).catch(() => undefined);
    const fingerprint = await keyFingerprint(this.apiKey);
    return !(await queue.has((w) => w.baseUrl === this.baseUrl && w.keyFingerprint === fingerprint && w.projectId === projectId));
  }

  private async drainQueue(): Promise<DrainReport> {
    const queue = await this.resolveQueue();
    if (!queue || (await queue.size()) === 0) return EMPTY_DRAIN_REPORT;
    const fingerprint = await keyFingerprint(this.apiKey);
    const report = await queue.drain(async (write: PendingWrite) => {
      if (write.baseUrl !== this.baseUrl || write.keyFingerprint !== fingerprint) return "keep";
      const deadlineMs = this.flushDeadline;
      if (deadlineMs !== undefined && Date.now() >= deadlineMs) return "stop"; // out of time: keep it and everything after it
      if (inFailureBackoff(write, Date.now())) return "stop"; // failed recently: wait, uncounted
      try {
        const reply = await this.sendOnce(write.projectId, write.action as MuninAction, this.rehydrate(write), `replay-${write.id}`);
        return replayVerdict(reply, write.action);
      } catch {
        return "stop"; // offline: try again on a later call, without limit
      }
    });
    this.deadLettered += report.dead;
    return report;
  }

  /**
   * The stored payload is complete: /api/mcp/action ignores payload.encryptionKey
   * and payload.apiKey, so a missing secret never stops a replay. A rehydrator
   * may still re-add them; null or an exception sends the stored payload.
   */
  private rehydrate(write: PendingWrite): Record<string, unknown> {
    if (write.strippedKeys.length === 0 || !this.rehydratePayload) return write.payload;
    try {
      return this.rehydratePayload(write.payload, write.strippedKeys) ?? write.payload;
    } catch {
      return write.payload;
    }
  }

  private async onMaintenance(
    projectId: string,
    action: string,
    payload: Record<string, unknown>,
    retryAfter: number | null,
    reason: MaintenanceReason = "maintenance",
  ): Promise<never> {
    const queue = isWriteAction(action) ? await this.resolveQueue() : null;
    if (!queue) throw new MuninMaintenanceError({ queued: false, action, retryAfterMs: retryAfter, reason });
    const { payload: safePayload, strippedKeys } = stripSecrets(payload);
    const write: PendingWrite = {
      id: globalThis.crypto.randomUUID(),
      queuedAt: new Date().toISOString(),
      baseUrl: this.baseUrl,
      keyFingerprint: await keyFingerprint(this.apiKey),
      projectId,
      action,
      payload: safePayload,
      strippedKeys,
    };
    await queue.enqueue(write);
    throw new MuninMaintenanceError({ queued: true, action, retryAfterMs: retryAfter, queueId: write.id, reason });
  }

  private async resolveQueue(): Promise<PendingWriteQueue | null> {
    if (this.writeQueueOption === false) return null;
    if (this.writeQueueOption) return this.writeQueueOption;
    if (!isNode()) return null;
    this.defaultQueue ??= import("./node/fileWriteQueue.js").then((m) => m.createFileWriteQueue());
    return this.defaultQueue;
  }

  private async sendOnce(projectId: string, action: MuninAction, payload: Record<string, unknown>, requestId?: string): Promise<Reply> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/mcp/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey: this.apiKey,
          project: projectId,
          projectId, // Fallback for un-restarted server
          action,
          payload,
          requestId,
          client: { name: CLIENT_NAME, version: CLIENT_VERSION },
        }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new MuninTransportError(`Request failed for action '${action}': ${String(error)}`);
    } finally {
      clearTimeout(timeout);
    }
    const text = await response.text();
    let body: any;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    const jsonBody = body !== null && typeof body === "object" && !Array.isArray(body);
    if (!jsonBody && !text) body = {};
    else if (!jsonBody) body = { ok: false, error: { code: "INTERNAL_ERROR", message: `Non-JSON response (${response.status})` } };
    const maintenance = isMaintenanceResponse(response.status, body);
    return {
      ok: response.ok && body.ok !== false && body.success !== false,
      status: response.status,
      body,
      jsonBody,
      maintenance,
      retryAfterMs: maintenance ? retryAfterMs(response.headers.get("retry-after"), body) : null,
    };
  }

  async store(projectId: string, payload: Record<string, unknown>): Promise<any> {
    return this.invoke(projectId, "store", payload, { ensureCapability: true });
  }
  async retrieve(projectId: string, payload: Record<string, unknown>): Promise<any> {
    return this.invoke(projectId, "retrieve", payload, { ensureCapability: true });
  }
  async search(projectId: string, payload: Record<string, unknown>): Promise<any> {
    return this.invoke(projectId, "search", payload, { ensureCapability: true });
  }
  async list(projectId: string, payload: Record<string, unknown> = {}): Promise<any> {
    return this.invoke(projectId, "list", payload, { ensureCapability: true });
  }
  async recent(projectId: string, payload: Record<string, unknown> = {}): Promise<any> {
    return this.invoke(projectId, "recent", payload, { ensureCapability: true });
  }
  async share(projectId: string, memoryIds: string[], targetProjectIds: string[]): Promise<any> {
    return this.invoke(projectId, "share", { memoryIds, targetProjectIds }, { ensureCapability: true });
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __munin_caps: { key: string; caps: MuninCapabilities } | undefined;
}
