import type { TipPoolFrequency } from "./types";

export interface DayOverride {
  employee_id: string;
  work_date: string;
  adj_hours: number | null;
  adj_paycheck_tips_cents: number | null;
  adj_cash_tips_cents: number | null;
  note: string | null;
}

export interface TipBucket {
  label: string;
  days: string[];
  pool_cents: number;
  pinned_cents: number;
  attributed_cents: number;
}

export interface CellHours { employeeId: string; date: string; hours: number }
export interface CellPin   { employeeId: string; date: string; cents: number }

export interface BucketAttribution {
  /** cellKey(sqId, date) -> cents */
  tips: Map<string, number>;
  attributedCents: number;
  pinnedCents: number;
}

export interface BucketViolation {
  label: string;
  kind: "pins_exceed_pool" | "no_absorber";
  poolCents: number;
  pinnedCents: number;
}

/** Maps are keyed by square_team_member_id — see spec §2 "ID space". */
export const cellKey = (sqId: string, date: string) => `${sqId}|${date}`;

export function getDays(startDate: string, endDate: string): string[] {
  const days: string[] = [];
  const cursor = new Date(startDate + "T12:00:00Z");
  const end = new Date(endDate + "T12:00:00Z");
  while (cursor <= end) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

export function dayGroups(days: string[], frequency: TipPoolFrequency): string[][] {
  if (frequency === "biweekly") return [days];
  if (frequency === "daily") return days.map(d => [d]);
  const groups: string[][] = [];
  for (let i = 0; i < days.length; i += 7) groups.push(days.slice(i, i + 7));
  return groups;
}

function fmtMonthDay(d: string): string {
  const [, m, day] = d.split("-");
  return `${parseInt(m)}/${parseInt(day)}`;
}

export function bucketLabels(
  frequency: TipPoolFrequency, startDate: string, endDate: string
): string[] {
  const days = getDays(startDate, endDate);
  if (frequency === "biweekly") return [`${fmtMonthDay(startDate)} – ${fmtMonthDay(endDate)}`];
  if (frequency === "daily") return days.map(fmtMonthDay);
  const labels: string[] = [];
  for (let i = 0; i < days.length; i += 7) {
    const w = days.slice(i, i + 7);
    labels.push(`${fmtMonthDay(w[0])} – ${fmtMonthDay(w[w.length - 1])}`);
  }
  return labels;
}

/**
 * Largest-remainder distribution: floor every exact share, then hand the
 * leftover cents to the largest fractional remainders. Guarantees the result
 * sums to `total` exactly — per-cell Math.round drifts, and the pool total is
 * an asserted invariant. Ties break on key so output is stable across runs.
 *
 * Preconditions (not validated at runtime):
 * - `weights` keys must be unique — a duplicate key is overwritten by
 *   `out.set` rather than accumulated, silently under-distributing.
 * - `total` must be an integer (callers pass cents) — a fractional total
 *   produces a sum larger than `total` since remainders are handed out as
 *   whole units.
 */
export function distributeByWeight(
  total: number,
  weights: Array<{ key: string; weight: number }>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const w of weights) out.set(w.key, 0);

  const positive = weights.filter(w => w.weight > 0);
  const sumW = positive.reduce((s, w) => s + w.weight, 0);
  if (sumW <= 0 || total <= 0) return out;

  const exact = positive.map(w => ({ key: w.key, v: (total * w.weight) / sumW }));
  let assigned = 0;
  for (const e of exact) {
    const floored = Math.floor(e.v);
    out.set(e.key, floored);
    assigned += floored;
  }

  const byRemainder = exact
    .map(e => ({ key: e.key, rem: e.v - Math.floor(e.v) }))
    .sort((a, b) => b.rem - a.rem || (a.key < b.key ? -1 : 1));

  let leftover = total - assigned;
  let i = 0;
  while (leftover > 0 && byRemainder.length > 0) {
    const k = byRemainder[i % byRemainder.length].key;
    out.set(k, (out.get(k) ?? 0) + 1);
    leftover--;
    i++;
  }
  return out;
}

/**
 * Single-step day-level split of one tip-pool bucket.
 *   tips[cell] = pin[cell]                            if pinned
 *              = (P - Σpins) x hours / Σ unpinned hours  otherwise
 *
 * Never throws: a pool can shrink below stored pins when a refund syncs late
 * (PR #276 attributes a refund to its original payment's day), so an already
 * stored, previously valid pin set can become invalid with no user action.
 * Read path degrades — unpinned cells clamp to 0, never negative — and the
 * caller surfaces the variance. The write path rejects via bucketViolations.
 *
 * Precondition (not validated at runtime): `pins` must contain at most one
 * entry per cell — two pins for the same cell make `pinnedCents` disagree
 * with what `tips` actually contributes to `attributedCents`, since the
 * later pin silently overwrites the earlier one in the map.
 */
export function attributeBucket(
  poolCents: number,
  cells: CellHours[],
  pins: CellPin[],
): BucketAttribution {
  const tips = new Map<string, number>();
  const pinKeys = new Set(pins.map(p => cellKey(p.employeeId, p.date)));

  let pinnedCents = 0;
  for (const p of pins) {
    tips.set(cellKey(p.employeeId, p.date), p.cents);
    pinnedCents += p.cents;
  }

  const unpinned = cells.filter(
    c => c.hours > 0 && !pinKeys.has(cellKey(c.employeeId, c.date))
  );
  for (const c of unpinned) tips.set(cellKey(c.employeeId, c.date), 0);

  const remainder = poolCents - pinnedCents;
  if (remainder > 0 && unpinned.length > 0) {
    const dist = distributeByWeight(
      remainder,
      unpinned.map(c => ({ key: cellKey(c.employeeId, c.date), weight: c.hours })),
    );
    for (const [k, v] of dist) tips.set(k, v);
  }

  let attributedCents = 0;
  for (const v of tips.values()) attributedCents += v;
  return { tips, attributedCents, pinnedCents };
}

/** Write-path guard. Conditions a save must never create; see spec §1. */
export function bucketViolations(buckets: TipBucket[]): BucketViolation[] {
  const out: BucketViolation[] = [];
  for (const b of buckets) {
    if (b.pinned_cents > b.pool_cents) {
      out.push({ label: b.label, kind: "pins_exceed_pool", poolCents: b.pool_cents, pinnedCents: b.pinned_cents });
    } else if (b.pinned_cents > 0 && b.attributed_cents < b.pool_cents) {
      out.push({ label: b.label, kind: "no_absorber", poolCents: b.pool_cents, pinnedCents: b.pinned_cents });
    }
  }
  return out;
}
