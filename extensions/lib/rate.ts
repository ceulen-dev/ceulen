/**
 * Cross-module handoff for the last generation rate. The usage module computes
 * tok/s on `message_end`; the composer renders it as a status item. Modules
 * stay decoupled — this is the sanctioned shared-code home.
 */

export interface GenRate {
  /** Whole tok/s of the last assistant response. */
  tps?: number;
}

let current: GenRate = {};

export function setGenRate(r: GenRate): void {
  current = r;
}

export function getGenRate(): GenRate {
  return current;
}

export function resetGenRate(): void {
  current = {};
}
