/**
 * Client-side worksheet math for the TTB F 5130.Pilot-B worksheet UI
 * (`app/finance/tax/parties/TtbBeerExcise/Worksheet.tsx`) — pure and
 * framework-free so it's unit-testable in isolation from React.
 *
 * `recomputeClientTtbTotals` re-derives the whole form on every manual-field
 * edit by calling the SAME `deriveTtbFigures` the server uses in
 * `mergeWorksheet`/`computeTtbFigures`, never a re-implementation of that
 * formula, so the client can never drift from what the server will actually
 * save on the next PATCH/recompute.
 *
 * `barrelsToString`/`stringToBarrels` are the string<->barrel boundary a barrel
 * `<input>` needs. Unlike the NC worksheet's whole-gallon helpers these keep 2
 * decimal places, because TTB reports fractional barrels and the shipment feed
 * is fractional at source — rounding to whole barrels here would throw away
 * real tax. `centsToDollarString`/`dollarStringToCents` are re-exported from the
 * generic money-string helpers (shared, not reimplemented).
 */
import type { WorksheetFields } from "@/lib/tax/types";
import { deriveTtbFigures, roundBbl } from "./parties/ttbBeerExcise/derive";

export { centsToDollarString, dollarStringToCents } from "./ncDorWorksheetMath";

/**
 * Returns a NEW field set with the whole form re-derived from `fields`,
 * mirroring the server's `deriveTtbFigures` exactly.
 */
export function recomputeClientTtbTotals(fields: WorksheetFields): WorksheetFields {
  return deriveTtbFigures(fields);
}

/**
 * A barrel count (possibly `null`/`undefined`/a numeric string) -> its display
 * string for a barrel input's `value`, to 2 decimal places (e.g. `248.6` ->
 * `"248.60"`). Never throws; non-finite/negative input clamps to `"0.00"`.
 */
export function barrelsToString(value: number | string | null | undefined): string {
  const n = Number(value ?? 0);
  const safe = Number.isFinite(n) ? Math.max(0, n) : 0;
  return roundBbl(safe).toFixed(2);
}

/**
 * A barrel input's raw text -> a non-negative barrel count rounded to 2
 * decimals. Blank or non-numeric text is treated as 0 barrels (a cleared
 * field) rather than `NaN`.
 */
export function stringToBarrels(value: string): number {
  const trimmed = value.trim();
  if (trimmed === "") return 0;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return 0;
  return roundBbl(Math.max(0, n));
}

/**
 * A rate in micro-dollars per unit -> its display string in dollars (e.g.
 * `3_500_000` -> `"3.50"`). Used by Schedule A's "applicable rate" column,
 * which is a per-unit rate rather than a money total.
 */
export function rateMicrosToString(value: number | string | null | undefined): string {
  const n = Number(value ?? 0);
  const safe = Number.isFinite(n) ? n : 0;
  return (safe / 1_000_000).toFixed(2);
}

/** A rate input's raw text (dollars per unit) -> micro-dollars per unit. Blank/non-numeric is 0. */
export function stringToRateMicros(value: string): number {
  const trimmed = value.trim();
  if (trimmed === "") return 0;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return 0;
  return Math.round(Math.max(0, n) * 1_000_000);
}
