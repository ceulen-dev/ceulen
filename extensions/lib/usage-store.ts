/**
 * Cross-module handoff for the provider's subscription usage: the usage module
 * computes quota windows on refresh; the composer renders them as a status
 * item next to git. Modules stay decoupled — same sanctioned pattern as
 * rate.ts.
 */

/** The usage module's `setStatus` key (shared so the composer's footer can
 *  filter it without string drift). */
export const USAGE_STATUS_KEY = "ceulen-usage";

export interface UsageItem {
  /** Provider slug for the short label — `router` renders `(router)`. */
  provider?: string;
  /** Pre-formatted windows, e.g. `R:59%/2H3M W:99%/2D3H`. */
  windows?: string;
  /** Color step: warning/error as the tightest window's remaining runs out. */
  tone?: "dim" | "warning" | "error";
}

let current: UsageItem = {};

export function setUsageItem(u: UsageItem): void {
  current = u;
}

export function getUsageItem(): UsageItem {
  return current;
}

export function resetUsageItem(): void {
  current = {};
}
