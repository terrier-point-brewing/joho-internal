import { fetchShiftsByDay, type DailyShift } from "@/lib/square/labor";
import { fetchTipsAndCashTakeByDay, type DailyTips } from "@/lib/square/payroll";
import type { Employee, PayPeriod, TipPoolFrequency } from "./types";

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

export interface UnattributedBucket {
  label: string;
  days: string[];
  poolCents: number;
  attributedCents: number;
  shortfallCents: number;
}

/**
 * Buckets whose pool was collected but never landed on an employee — the day
 * took card tips and no tipped employee had hours, so `attributeBucket` had no
 * cell to distribute to and the money silently disappeared from payroll.
 *
 * Deliberately NOT part of `bucketViolations`: that guard runs on every day
 * override save, and an unattributed day elsewhere in the period would then
 * block the very override that fixes it. This is a lock-time gate instead —
 * see the lock route. Reported per bucket (not per day) because a bucket is
 * the unit the pool is attributed over; under daily pooling they coincide.
 */
export function unattributedBuckets(buckets: TipBucket[]): UnattributedBucket[] {
  return buckets
    .filter(b => b.attributed_cents < b.pool_cents)
    .map(b => ({
      label: b.label,
      days: b.days,
      poolCents: b.pool_cents,
      attributedCents: b.attributed_cents,
      shortfallCents: b.pool_cents - b.attributed_cents,
    }));
}

/**
 * Live pool vs. what the lock snapshotted. A refund that syncs after a period
 * is locked changes the net pool (see aggregateDailyTips — a refunded tip is
 * netted out of its ORIGINAL payment's day), but the snapshot in
 * payroll_entries is frozen, so the two quietly disagree forever.
 *
 * Positive = the snapshot paid out more than the pool now holds (the usual
 * case: a late refund). Negative = the pool grew after the lock. Returns null
 * when they agree, so callers can render nothing without a comparison.
 */
export function snapshotPoolVariance(
  livePoolCents: number,
  snapshotTipsCents: number,
): { livePoolCents: number; snapshotTipsCents: number; varianceCents: number } | null {
  const varianceCents = snapshotTipsCents - livePoolCents;
  if (varianceCents === 0) return null;
  return { livePoolCents, snapshotTipsCents, varianceCents };
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

export interface DailyGrid {
  days: string[];
  /** date -> square_team_member_id -> value */
  hoursByDate: Map<string, Map<string, number>>;
  cashByDate: Map<string, Map<string, number>>;
  cardTipsByDate: Map<string, Map<string, number>>;
  buckets: TipBucket[];
  totalPooledTipsCents: number;
}

function setCell(m: Map<string, Map<string, number>>, date: string, sqId: string, v: number) {
  if (!m.has(date)) m.set(date, new Map());
  m.get(date)!.set(sqId, v);
}
function addCell(m: Map<string, Map<string, number>>, date: string, sqId: string, v: number) {
  if (!m.has(date)) m.set(date, new Map());
  const inner = m.get(date)!;
  inner.set(sqId, (inner.get(sqId) ?? 0) + v);
}

/**
 * The Square data one grid computation needs. Fetching is split from computing
 * so a caller that needs several grids over the SAME period — the Shifts route
 * (overridden + baseline) and the override write path (pool-guard validation) —
 * pays for the I/O once instead of once per grid.
 */
export interface DayGridInputs {
  rawShifts: DailyShift[];
  dailyTips: DailyTips[];
}

/** The only I/O. Three paginated Square endpoint sequences; call once per period. */
export async function fetchDayGridInputs(period: PayPeriod): Promise<DayGridInputs> {
  const [rawShifts, dailyTips] = await Promise.all([
    fetchShiftsByDay(period.start_date, period.end_date),
    fetchTipsAndCashTakeByDay(period.start_date, period.end_date),
  ]);
  return { rawShifts, dailyTips };
}

/**
 * Single owner of day-level payroll computation. Both the Shifts route and
 * previewService consume this; they used to duplicate it and had drifted.
 * Maps key on square_team_member_id (spec §2 "ID space"); override rows are
 * translated employee-id -> square-id once here.
 *
 * Pure and synchronous — same inputs always give the same grid, so computing a
 * second grid (e.g. the no-override baseline) costs no I/O.
 */
export function computeDailyGrid(
  inputs: DayGridInputs,
  period: PayPeriod,
  employees: Employee[],
  tipPoolFrequency: TipPoolFrequency,
  overrides: DayOverride[],
): DailyGrid {
  const days = getDays(period.start_date, period.end_date);

  const sqByEmployeeId = new Map(
    employees.filter(e => e.square_team_member_id).map(e => [e.id, e.square_team_member_id!])
  );
  const tippedSqIds = new Set(
    employees
      .filter(e => e.employment_type === "hourly" && e.receives_tips && e.active && e.square_team_member_id)
      .map(e => e.square_team_member_id!)
  );

  const { rawShifts, dailyTips } = inputs;

  const hoursByDate = new Map<string, Map<string, number>>();
  const cashByDate  = new Map<string, Map<string, number>>();
  for (const s of rawShifts) {
    addCell(hoursByDate, s.date, s.team_member_id, s.hours);
    addCell(cashByDate,  s.date, s.team_member_id, s.cash_tips_cents);
  }

  // Layer 1: day overrides replace the Square-derived value outright. An
  // override may create a cell that has no underlying shift (missed punch).
  const pinsByDate = new Map<string, Map<string, number>>();
  for (const o of overrides) {
    const sqId = sqByEmployeeId.get(o.employee_id);
    if (!sqId) continue;
    if (o.adj_hours != null) setCell(hoursByDate, o.work_date, sqId, o.adj_hours);
    if (o.adj_cash_tips_cents != null) setCell(cashByDate, o.work_date, sqId, o.adj_cash_tips_cents);
    if (o.adj_paycheck_tips_cents != null) setCell(pinsByDate, o.work_date, sqId, o.adj_paycheck_tips_cents);
  }

  const poolByDay = new Map(dailyTips.map(t => [t.date, t.tipsPooledCents]));
  const groups = dayGroups(days, tipPoolFrequency);
  const labels = bucketLabels(tipPoolFrequency, period.start_date, period.end_date);

  const cardTipsByDate = new Map<string, Map<string, number>>();
  const buckets: TipBucket[] = [];
  let totalPooledTipsCents = 0;

  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    let poolCents = 0;
    const cells: CellHours[] = [];
    const pins: CellPin[] = [];

    for (const day of group) {
      poolCents += poolByDay.get(day) ?? 0;
      for (const [sqId, hours] of hoursByDate.get(day) ?? []) {
        if (tippedSqIds.has(sqId)) cells.push({ employeeId: sqId, date: day, hours });
      }
      for (const [sqId, cents] of pinsByDate.get(day) ?? []) {
        if (tippedSqIds.has(sqId)) pins.push({ employeeId: sqId, date: day, cents });
      }
    }
    totalPooledTipsCents += poolCents;

    const { tips, attributedCents, pinnedCents } = attributeBucket(poolCents, cells, pins);
    for (const [key, cents] of tips) {
      const [sqId, day] = key.split("|");
      setCell(cardTipsByDate, day, sqId, cents);
    }

    buckets.push({
      label: labels[gi] ?? `Bucket ${gi + 1}`,
      days: group,
      pool_cents: poolCents,
      pinned_cents: pinnedCents,
      attributed_cents: attributedCents,
    });
  }

  return { days, hoursByDate, cashByDate, cardTipsByDate, buckets, totalPooledTipsCents };
}

/**
 * Fetch + compute in one call. Convenience for the single-grid callers
 * (previewService); a caller needing two grids over the same period should use
 * fetchDayGridInputs once and computeDailyGrid per grid instead, or it pays for
 * the Square round-trips twice.
 */
export async function buildDailyGrid(
  period: PayPeriod,
  employees: Employee[],
  tipPoolFrequency: TipPoolFrequency,
  overrides: DayOverride[],
): Promise<DailyGrid> {
  const inputs = await fetchDayGridInputs(period);
  return computeDailyGrid(inputs, period, employees, tipPoolFrequency, overrides);
}
