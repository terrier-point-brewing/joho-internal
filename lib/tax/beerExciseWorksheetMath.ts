/**
 * Client-side worksheet math for the NC DOR Beer Excise (B-C-710) worksheet
 * UI (`app/finance/tax/parties/NcDorBeerExcise/Worksheet.tsx`) — pure and
 * framework-free so it's unit-testable in isolation from React.
 *
 * `recomputeClientBeerTotals` re-derives the full Line 2-11 waterfall on
 * every manual-field edit by calling the SAME `deriveBeerExciseFigures` the
 * server uses in `mergeWorksheet`/`computeBeerExciseFigures`
 * (`./parties/ncDorBeerExcise/derive.ts`), never a re-implementation of that
 * formula, so the client can never drift from what the server will actually
 * save on the next PATCH/recompute.
 *
 * `gallonsToString`/`stringToGallons` are the string<->whole-gallon boundary
 * a gallon `<input>` needs. `centsToDollarString`/`dollarStringToCents` are
 * re-exported from the generic `./ncDorWorksheetMath` money-string helpers
 * (shared, not reimplemented).
 */
import type { WorksheetFields } from "@/lib/tax/types";
import { deriveBeerExciseFigures } from "./parties/ncDorBeerExcise/derive";

export { centsToDollarString, dollarStringToCents } from "./ncDorWorksheetMath";

/**
 * Returns a NEW field set with the full Line 2-11 waterfall re-derived from
 * `fields`, mirroring the server's `deriveBeerExciseFigures` exactly.
 */
export function recomputeClientBeerTotals(fields: WorksheetFields): WorksheetFields {
  return deriveBeerExciseFigures(fields);
}

/**
 * A whole gallon count (possibly `null`/`undefined`/a numeric string) -> its
 * display string for a gallon input's `value` (e.g. `310` -> `"310"`).
 * Never throws; non-finite/negative input clamps to `"0"`.
 */
export function gallonsToString(value: number | string | null | undefined): string {
  const n = Number(value ?? 0);
  const safe = Number.isFinite(n) ? n : 0;
  return String(Math.max(0, Math.round(safe)));
}

/**
 * A gallon input's raw text -> a whole non-negative gallon count. Blank or
 * non-numeric text is treated as 0 gallons (a cleared field) rather than
 * `NaN`.
 */
export function stringToGallons(value: string): number {
  const trimmed = value.trim();
  if (trimmed === "") return 0;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round(n));
}
