// Cron schedule math — hand-rolled 5-field matcher. One file so the
// implementation can be swapped without touching callers (upstream shipped
// cron-parser here; swapped per the ceulen zero-runtime-deps policy —
// cron-parser hard-depends on luxon, ~4.5MB, for timezone machinery a
// local-time session scheduler never needs).
//
// ponytail: minute-scan nextFire (≤527k iterations for a never-matching expr,
// typical fire <2k) — field-index jump if profiling ever demands it.
//
// Semantics (POSIX vixie-cron):
//   fields: minute hour day-of-month month day-of-week
//   each:   * | */step | a | a-b | a-b/step | a,b,c (lists of any member)
//   names:  jan..dec, sun..sat (case-insensitive); dow 0 and 7 both = Sunday
//   OR rule: when BOTH dom and dow are restricted (neither `*`-only), a day
//   matches if EITHER field matches — the one vixie-cron quirk hand-rolls
//   usually get wrong.
// No seconds / year / L / # / TZ — rejected by validate.

/** One parsed field: the set of allowed integers within the field's range. */
type Field = Set<number>;

interface FieldSpec {
  min: number;
  max: number;
  /** Extra alias both modulo (0/7 → Sunday) and names resolve against. */
  names?: Record<string, number>;
}

const SPECS: FieldSpec[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  {
    min: 1,
    max: 12,
    names: { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 },
  },
  {
    min: 0,
    max: 7,
    names: { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 },
  },
];

/** Expand one comma-separated member (`*`, `n`, `a-b`, with optional `/step`)
 *  into allowed values. Throws with a human message on garbage. */
function expandMember(member: string, spec: FieldSpec): number[] {
  // Atoms are digits or 3-letter names (jan..dec / sun..sat); `*` only alone.
  const m = member.match(/^(\*|[a-z\d]+)(?:-([a-z\d]+))?(?:\/(\d+))?$/);
  if (!m) throw new Error(`bad cron member '${member}'`);
  const step = m[3] !== undefined ? Number(m[3]) : 1;
  if (!Number.isInteger(step) || step < 1) throw new Error(`bad cron step in '${member}'`);
  let lo: number;
  let hi: number;
  if (m[1] === "*") {
    lo = spec.min;
    hi = spec.max;
  } else {
    lo = resolveAtom(m[1], spec);
    hi = m[2] !== undefined ? resolveAtom(m[2], spec) : lo;
  }
  if (m[2] !== undefined && hi < lo) throw new Error(`bad cron range '${member}'`);
  const out: number[] = [];
  for (let v = lo; v <= hi; v += step) out.push(v);
  return out;
}

/** Resolve one atom: name alias or integer. Dow 7 folds to 0 (Sunday). */
function resolveAtom(atom: string, spec: FieldSpec): number {
  const lower = atom.toLowerCase();
  const v = spec.names?.[lower] ?? (/^\d+$/.test(atom) ? Number(atom) : NaN);
  if (!Number.isInteger(v) || v < spec.min || v > spec.max) {
    throw new Error(`cron value ${atom} out of range ${spec.min}-${spec.max}`);
  }
  return spec.names && v === 7 ? 0 : v;
}

/** Parse one 5-field expression into per-field value sets.
 *  Exported for tests. */
export function parseSchedule(expr: string): Field[] {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error("expected 5 fields (minute hour day-of-month month day-of-week), e.g. '0 9 * * mon'");
  }
  return fields.map((f, i) => {
    const spec = SPECS[i]!;
    const set: Field = new Set();
    for (const member of f.split(",")) {
      if (!member) throw new Error(`empty cron member in '${f}'`);
      for (const v of expandMember(member, spec)) set.add(v);
    }
    if (set.size === 0) throw new Error(`cron field '${f}' matches nothing`);
    return set;
  });
}

/** True when a field spec is "restricted" for the dom/dow OR rule: any member
 *  other than a bare star (`*` alone; a step like star-slash-2 counts as
 *  restricted). */
function isRestricted(member: string): boolean {
  return member.trim() !== "*";
}

/** Day matches when dom OR dow matches — but ONLY when both fields are
 *  restricted; with either unrestricted, standard AND semantics apply. */
function dayMatches(dom: Field, dow: Field, domRestricted: boolean, dowRestricted: boolean, date: Date): boolean {
  const domHit = dom.has(date.getDate());
  const dowHit = dow.has(date.getDay());
  if (domRestricted && dowRestricted) return domHit || dowHit;
  return domHit && dowHit;
}

export function validateSchedule(expr: string): string | null {
  try {
    parseSchedule(expr);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export function nextFire(expr: string, from: Date): Date | null {
  let fields: Field[];
  let domRestricted: boolean;
  let dowRestricted: boolean;
  try {
    fields = parseSchedule(expr);
    const members = expr.trim().split(/\s+/);
    domRestricted = isRestricted(members[2]!);
    dowRestricted = isRestricted(members[4]!);
  } catch {
    return null;
  }
  const t = new Date(from.getTime());
  t.setSeconds(0, 0);
  const cap = new Date(t.getTime());
  // 4 years = the full leap cycle — "0 0 29 2 *" must find its next fire from
  // any start date; never-firing exprs (Feb 30) scan ~2.1M cheap set checks.
  cap.setFullYear(cap.getFullYear() + 4);
  for (;;) {
    t.setMinutes(t.getMinutes() + 1);
    if (t > cap) return null; // e.g. Feb 30 — never fires
    if (!fields[0]!.has(t.getMinutes())) continue;
    if (!fields[1]!.has(t.getHours())) continue;
    if (!fields[3]!.has(t.getMonth() + 1)) continue; // Date months are 0-11; specs are 1-12
    if (!dayMatches(fields[2]!, fields[4]!, domRestricted, dowRestricted, t)) continue;
    return new Date(t.getTime());
  }
}

export function nextFires(expr: string, n: number, from: Date): Date[] {
  const out: Date[] = [];
  let cursor = from;
  for (let i = 0; i < n; i++) {
    const next = nextFire(expr, cursor);
    if (!next) break;
    out.push(next);
    cursor = next;
  }
  return out;
}
