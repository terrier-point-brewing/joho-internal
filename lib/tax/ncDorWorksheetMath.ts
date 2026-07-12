/**
 * Client-side worksheet math for the NC DOR Sales & Use worksheet UI
 * (`app/finance/tax/parties/NcDorSalesUse/Worksheet.tsx`) — pure and
 * framework-free so it's unit-testable in isolation from React.
 *
 * Two concerns:
 *  - `recomputeClientTotals` re-derives the dependent totals (lines 13/15/21)
 *    on every manual-field edit so the worksheet updates instantly, by
 *    calling the SAME `computeDependentTotals` the server uses in
 *    `mergeWorksheet`/`computeNcDorFigures` (`./parties/ncDorSalesUse/calc.ts`)
 *    — never a re-implementation of that formula — so the client can never
 *    drift from what the server will actually save on the next PATCH/recompute.
 *  - `centsToDollarString`/`dollarStringToCents` are the string<->cents
 *    boundary a money `<input>` needs (parsing free text, defensive
 *    null/blank handling); the underlying numeric crossing is delegated to
 *    `lib/money.ts` (`centsToDollars`/`dollarsToCents`), the single dollars<->
 *    cents conversion point for the whole app.
 */
import { centsToDollars, dollarsToCents } from "@/lib/money";
import { computeDependentTotals } from "./parties/ncDorSalesUse/calc";

type WorksheetFields = Record<string, number | string | null>;

/**
 * Returns a NEW fields object with line13_total/line15_total/line21_total_due
 * refreshed from the rest of `fields`, mirroring `computeDependentTotals`
 * exactly. All other keys pass through unchanged.
 */
export function recomputeClientTotals(fields: WorksheetFields): WorksheetFields {
  const totals = computeDependentTotals(fields);
  return {
    ...fields,
    line13_total: totals.line13_total,
    line15_total: totals.line15_total,
    line21_total_due: totals.line21_total_due,
  };
}

/**
 * Integer cents (possibly `null`/`undefined`/a numeric string) -> a fixed
 * 2-decimal dollar string for a money input's `value` (e.g. `1234` -> `"12.34"`,
 * `null` -> `"0.00"`). Never throws; non-finite input is treated as 0 cents.
 */
export function centsToDollarString(value: number | string | null | undefined): string {
  const n = Number(value ?? 0);
  const safe = Number.isFinite(n) ? n : 0;
  return centsToDollars(safe).toFixed(2);
}

/**
 * A money input's raw text -> integer cents, rounded to the nearest cent.
 * Blank, a bare sign/decimal point, or non-numeric text is treated as 0 cents
 * (a cleared field) rather than `NaN` — the input is mid-edit, not invalid.
 */
export function dollarStringToCents(value: string): number {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "-" || trimmed === "." || trimmed === "-.") return 0;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return 0;
  return dollarsToCents(n);
}
