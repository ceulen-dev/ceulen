// Cross-module contract: the subagent module's herdr runner spawns child panes
// with ADVISOR_MARKER_ENV naming a JSON sidecar; the advisor module running
// inside that child publishes its review cycle there, so the parent can wait
// for the advisor verdict instead of collecting a draft the advisor is about
// to correct. See subagent/lib/herdr.ts (reader) and advisor/lib/watcher.ts
// (writer). The parent's own advisor never sees the env var, so this is inert
// outside delegated panes.

/** Env var naming the sidecar file (absolute path). */
export const ADVISOR_MARKER_ENV = "CEULEN_ADVISOR_MARKER";

export interface AdvisorMarker {
  /** "reviewing" while the isolated review call runs; "done" when the cycle
   *  ended (steered or not) — every exit path publishes "done". */
  phase: "reviewing" | "done";
  /** True when this cycle steered a follow-up turn into the child. */
  steered: boolean;
  /** Producer clock (ms) — same machine, so freshness comparisons are safe. */
  at: number;
}

/** Parse a marker payload. Undefined for absent/corrupt/unknown shapes — the
 *  caller must treat that as "no advisor", never as "review in progress". */
export function parseAdvisorMarker(raw: string | undefined | null): AdvisorMarker | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<AdvisorMarker>;
    if ((value.phase === "reviewing" || value.phase === "done") && typeof value.at === "number" && Number.isFinite(value.at)) {
      return { phase: value.phase, steered: value.steered === true, at: value.at };
    }
  } catch { /* not JSON — treated as no signal */ }
  return undefined;
}
