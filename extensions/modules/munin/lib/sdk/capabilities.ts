// ponytail: vendored from @kalera/munin-sdk 1.6.0 (dist/capabilities.js + capabilities.d.ts).
// Local delta 2: fetchCapabilities takes a timeoutMs (upstream has 3 params and no
// signal), so a dead capabilities endpoint cannot park a munin_* call forever.

import { MuninSdkError, MuninTransportError } from "./errors.js";
import type { MuninCapabilities, MuninResponse } from "./types.js";

const DEFAULT_TIMEOUT_MS = 15_000;

export async function fetchCapabilities(
  baseUrl: string,
  apiKey?: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<MuninCapabilities> {
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
