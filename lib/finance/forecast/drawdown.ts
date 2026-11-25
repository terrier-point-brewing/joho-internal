// Drawdown: how fast brewed beer has historically left the brewery, and what
// that implies for the months ahead.
//
// Commitment delivery dates are not reliable enough to schedule revenue from,
// so nothing here reads them. Instead every past batch contributes one fact —
// how many days after brew day each barrel shipped — and the forecast replays
// that curve over the beer on hand today and the beer still to be brewed.
//
// Pure: no database, no clock. `asOf` is always passed in.

import { DRAWDOWN_CHANNELS, type DrawdownBatch, type DrawdownChannel, type ForecastDrivers } from "./types";

const DAY_MS = 86_400_000;
/** Mean days in a month, for turning a monthly brewing pace into weekly brews. */
const DAYS_PER_MONTH = 30.44;

function toUtc(date: string): number {
  return Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
}

/** Whole days from `from` to `to` (both YYYY-MM-DD). Negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((toUtc(to) - toUtc(from)) / DAY_MS);
}

export function addDays(date: string, n: number): string {
  return new Date(toUtc(date) + n * DAY_MS).toISOString().slice(0, 10);
}

/** "YYYY-MM" shifted by `n` months. */
export function addMonths(month: string, n: number): string {
  const index = Number(month.slice(0, 4)) * 12 + (Number(month.slice(5, 7)) - 1) + n;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

/** First day of `month`, and the first day of the month after it. */
export function monthBounds(month: string): { start: string; end: string } {
  return { start: `${month}-01`, end: `${addMonths(month, 1)}-01` };
}

// ── Measuring the curve ─────────────────────────────────────────────────────

export interface HistoryBatch {
  id: string;
  brewDate: string;
  bbl: number;
}

export interface HistoryShipment {
  batchId: string;
  channel: DrawdownChannel;
  date: string;
  bbl: number;
}

export interface DrawdownHistory {
  curveStepDays: number;
  curves: Record<DrawdownChannel, number[]>;
  shipFraction: Record<DrawdownChannel, number>;
  matureBatchCount: number;
}

/** A batch younger than this may still have beer to ship, so it cannot teach the curve anything yet. */
export const MATURE_DAYS = 120;
const STEP_DAYS = 7;
const MAX_STEPS = 36; // 252 days; anything later counts as shipped on the last step

function emptyByChannel<T>(make: () => T): Record<DrawdownChannel, T> {
  return { contract_brewing: make(), distribution: make(), taproom: make() };
}

/**
 * The cumulative shipping curve per channel and each channel's share of a
 * brewed barrel, measured on mature batches only.
 *
 * A channel with no mature shipments borrows the all-channel curve; with no
 * mature shipments at all the curve is a straight line over 60 days, which is
 * a placeholder rather than a measurement and is why `matureBatchCount` is
 * reported alongside.
 */
export function buildDrawdownHistory(asOf: string, batches: HistoryBatch[], shipments: HistoryShipment[]): DrawdownHistory {
  const mature = new Map(batches.filter((b) => daysBetween(b.brewDate, asOf) >= MATURE_DAYS && b.bbl > 0).map((b) => [b.id, b]));

  const buckets = emptyByChannel(() => new Array<number>(MAX_STEPS + 1).fill(0));
  const combined = new Array<number>(MAX_STEPS + 1).fill(0);
  const shipped = emptyByChannel(() => 0);

  for (const s of shipments) {
    const batch = mature.get(s.batchId);
    if (!batch || s.bbl <= 0) continue;
    const days = Math.max(0, daysBetween(batch.brewDate, s.date));
    const step = Math.min(MAX_STEPS, Math.ceil(days / STEP_DAYS));
    buckets[s.channel][step] += s.bbl;
    combined[step] += s.bbl;
    shipped[s.channel] += s.bbl;
  }

  const cumulative = (bucket: number[]): number[] | null => {
    const total = bucket.reduce((a, b) => a + b, 0);
    if (total <= 0) return null;
    let running = 0;
    const curve = bucket.map((v) => (running += v) / total);
    curve[0] = 0;
    curve[curve.length - 1] = 1;
    return curve;
  };

  const fallback =
    cumulative(combined) ?? Array.from({ length: MAX_STEPS + 1 }, (_, i) => Math.min(1, (i * STEP_DAYS) / 60));

  const brewed = [...mature.values()].reduce((sum, b) => sum + b.bbl, 0);
  const curves = emptyByChannel<number[]>(() => []);
  const shipFraction = emptyByChannel(() => 0);
  for (const c of DRAWDOWN_CHANNELS) {
    curves[c] = cumulative(buckets[c]) ?? fallback;
    shipFraction[c] = brewed > 0 ? shipped[c] / brewed : 0;
  }

  return { curveStepDays: STEP_DAYS, curves, shipFraction, matureBatchCount: mature.size };
}

// ── Replaying it ────────────────────────────────────────────────────────────

/** Share of a channel's eventual shipments that have left `ageDays` after brew day. Linear between measured steps. */
export function shippedShareAt(curve: number[], stepDays: number, ageDays: number): number {
  if (ageDays <= 0 || curve.length === 0) return 0;
  const position = ageDays / stepDays;
  const lower = Math.floor(position);
  if (lower >= curve.length - 1) return 1;
  return curve[lower] + (curve[lower + 1] - curve[lower]) * (position - lower);
}

export interface DrawdownLevers {
  /** null = the historical pace. */
  brewBblPerMonth: number | null;
  drawdownSpeedPct: number;
  yieldLossPct: number;
}

type ShipmentDrivers = Pick<ForecastDrivers, "asOf" | "curveStepDays" | "curves" | "shipFraction" | "batches" | "brewPaceBblPerMonth">;

/**
 * Projected shipped bbl per channel for each month in `months`.
 *
 * Two populations:
 *   - beer already brewed: what a batch is still expected to ship (its
 *     historical share of a brewed barrel, less what has already left, never
 *     more than is physically left) is spread over the future along the part
 *     of the curve the batch has not reached yet;
 *   - beer not yet brewed: one synthetic brew a week at the assumed pace, each
 *     shipping along the whole curve.
 */
export function projectShipments(
  drivers: ShipmentDrivers,
  months: string[],
  levers: DrawdownLevers,
): Record<DrawdownChannel, Record<string, number>> {
  const out = emptyByChannel<Record<string, number>>(() => ({}));
  for (const c of DRAWDOWN_CHANNELS) for (const m of months) out[c][m] = 0;
  if (months.length === 0) return out;

  const speed = Math.max(0.1, 1 + levers.drawdownSpeedPct / 100);
  const yieldFactor = Math.max(0, 1 - levers.yieldLossPct / 100);
  const { asOf, curveStepDays: step, curves, shipFraction } = drivers;
  const share = (c: DrawdownChannel, ageDays: number) => shippedShareAt(curves[c], step, ageDays * speed);

  const addBatch = (batch: DrawdownBatch, existing: boolean) => {
    const ageNow = Math.max(0, daysBetween(batch.brewDate, asOf));
    let scale = batch.bbl * yieldFactor;
    if (existing) {
      const expectedTotal = DRAWDOWN_CHANNELS.reduce((sum, c) => sum + shipFraction[c], 0) * batch.bbl * yieldFactor;
      const remaining = Math.min(Math.max(0, expectedTotal - batch.shippedBbl), Math.max(0, batch.bbl - batch.shippedBbl));
      // Past the end of the MEASURED curve with beer still on hand: history
      // says it does not ship, so it is not counted on. Judged at the real
      // speed, so the speed lever can re-time beer but never conjure or lose it.
      const unreachedAtHistory = DRAWDOWN_CHANNELS.reduce(
        (sum, c) => sum + shipFraction[c] * (1 - shippedShareAt(curves[c], step, ageNow)),
        0,
      );
      if (remaining <= 0 || unreachedAtHistory < 1e-6) return;
      const unreached = DRAWDOWN_CHANNELS.reduce((sum, c) => sum + shipFraction[c] * (1 - share(c, ageNow)), 0);
      if (unreached < 1e-6) {
        // Sped up past the end of the curve: what is left goes out at once.
        const fractions = DRAWDOWN_CHANNELS.reduce((sum, c) => sum + shipFraction[c], 0);
        for (const c of DRAWDOWN_CHANNELS) out[c][months[0]] += (remaining * shipFraction[c]) / fractions;
        return;
      }
      scale = remaining / unreached;
    }
    for (const m of months) {
      const { start, end } = monthBounds(m);
      const from = Math.max(existing ? ageNow : 0, daysBetween(batch.brewDate, start));
      const to = daysBetween(batch.brewDate, end);
      if (to <= from) continue;
      for (const c of DRAWDOWN_CHANNELS) {
        out[c][m] += scale * shipFraction[c] * (share(c, to) - share(c, from));
      }
    }
  };

  for (const batch of drivers.batches) addBatch(batch, true);

  const pace = Math.max(0, levers.brewBblPerMonth ?? drivers.brewPaceBblPerMonth);
  const weeklyBbl = (pace * 7) / DAYS_PER_MONTH;
  const lastDay = monthBounds(months[months.length - 1]).end;
  if (weeklyBbl > 0) {
    for (let brewDate = addDays(asOf, 7); brewDate < lastDay; brewDate = addDays(brewDate, 7)) {
      addBatch({ brewDate, bbl: weeklyBbl, shippedBbl: 0 }, false);
    }
  }

  return out;
}
