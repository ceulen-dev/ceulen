// Time context — the model-visible clock pi does not inject anywhere.
//
// Ported from DeepSeek Harness `packages/context/time-context` (renderText +
// the 10-minute durable refresh). pi's system prompt carries no date/time at
// all (dist/core/system-prompt.js renders with `timestamp: 0`), so a long
// session — goal mode, cron loops, multi-hour refactors — has no way to know
// when "today" is or how long it has been running.
//
// Deliberate reductions from DSH: no browser-timezone negotiation (that is a
// web-app concept; a TUI has one process zone), no session projection (pi
// rehydrates nothing here — the maps are per-process and per-session-id), and
// no turn/step numbering in the line (pi's turn index is not model-meaningful
// and would churn with every turn).
//
// Cache-safety: one injected message per refresh WINDOW (default 10 minutes),
// appended after the user message, so a long session adds a handful of small
// messages instead of one per turn. This is DSH's append-only policy verbatim.

/** Default minutes-scale refresh window (DSH refreshIntervalMs default). */
export const DEFAULT_CLOCK_REFRESH_MS = 600_000;

/** Compact whole-second duration: `2d 3h 5m 7s` (DSH formatDuration). */
export function formatDuration(elapsedMs: number): string {
  // A backward wall-clock reading is a property of the clock, not the span.
  const total = Math.max(0, Math.floor(elapsedMs / 1000));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(" ");
}

/**
 * ISO-8601 timestamp with a numeric UTC offset and the IANA zone name.
 * The numeric offset is what a model does arithmetic with; the zone name is
 * what makes a DST boundary legible — DSH keeps both for the same reason.
 */
export function formatTimestamp(now: number, timeZone?: string): string {
  const date = new Date(now);
  const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const iso = isoWithOffset(date, zone);
  return `${iso} (${zone})`;
}

/** `YYYY-MM-DDTHH:mm:ss±HH:MM` for an instant rendered in `timeZone`. */
function isoWithOffset(date: Date, timeZone: string): string {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(date);
  } catch {
    // Unknown zone → fall back to the process zone rather than dropping the clock.
    return isoWithOffset(date, Intl.DateTimeFormat().resolvedOptions().timeZone);
  }
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "00";
  // Intl renders midnight as 24 in some ICU builds; normalise to 00.
  const hour = get("hour") === "24" ? "00" : get("hour");
  const stamp = `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}:${get("second")}`;
  return `${stamp}${offsetFor(date, timeZone)}`;
}

/** Numeric UTC offset (`+07:00`) of `timeZone` at instant `date`. */
function offsetFor(date: Date, timeZone: string): string {
  try {
    const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
      .formatToParts(date)
      .find((p) => p.type === "timeZoneName")?.value;
    const match = name?.match(/GMT([+-]\d{2}:\d{2})?/);
    if (match) return match[1] ?? "+00:00";
  } catch { /* fall through to UTC */ }
  return "+00:00";
}

/** The two-line clock message body. */
export function renderClock(now: number, elapsedMs: number | undefined, timeZone?: string): string {
  const elapsed = elapsedMs === undefined ? "unavailable" : formatDuration(elapsedMs);
  return `Time: ${formatTimestamp(now, timeZone)}\nElapsed since last activity: ${elapsed}`;
}

/** Per-session clock bookkeeping. */
export interface ClockState {
  lastInjection: number;
  lastActivity?: number;
}

/** Whether this session is due for an injection given its refresh window. */
export function shouldInject(state: ClockState | undefined, now: number, refreshMs: number): boolean {
  if (refreshMs <= 0) return true;
  if (state === undefined) return true;
  const since = now - state.lastInjection;
  // A backward clock reading must not park the clock forever.
  return since < 0 || since >= refreshMs;
}
