/**
 * TTB Pilot Brewer Excise Tax Return (TTB F 5130.Pilot-B) — statutory rate
 * tiers, taxable-channel rule, serial-number format and reference tables.
 *
 * Zero server imports so this stays importable by both the pure
 * ./fieldOwnership.ts / ./derive.ts modules (client-safe) and the server-side
 * ./calc.ts / ./template.ts.
 *
 * WHY the taxable-channel set is declared HERE and not reused from
 * `../ncDorBeerExcise/rates.ts`: the two returns tax different things off the
 * SAME shipment feed. NC excludes the `wholesale` channel because the
 * wholesaler remits that tax (B-C-710 Line 4a). Federally there is no such
 * exclusion — 26 U.S.C. 5054 taxes beer when it is REMOVED from the brewery
 * for consumption or sale, whoever buys it. The only federal exclusions are
 * removals without payment of tax (exports, transfers in bond), which are not
 * a channel on `export_transactions` at all and are therefore manual entry on
 * Lines 34-36. Sharing NC's `TAXABLE_CHANNELS` here would silently under-report
 * federal tax the moment a wholesale shipment is recorded.
 */
import type { ReferenceSpec } from "@/lib/tax/types";

/**
 * Every shipment channel is a taxable federal removal. Declared as a Set (not
 * a "taxable vs. excluded" split like NC's) because there is no federal
 * channel exclusion to express — see the file header.
 */
export const TTB_TAXABLE_CHANNELS: ReadonlySet<string> = new Set([
  "distribution",
  "contract_brewing",
  "taproom",
  "wholesale",
]);

/**
 * The reduced rate on the first 60,000 barrels removed per calendar year by a
 * brewer producing under 2,000,000 barrels (26 U.S.C. 5051(a)(2)). This is the
 * only tier this brewery reaches; Lines 9 and 10 exist on the form and are
 * rendered, but always zero. `federal_beer_excise` in `tax_rates` carries the
 * live value — this is the statutory fallback when that row is absent.
 */
export const TTB_REDUCED_RATE_USD_FALLBACK = 3.5;

/** Line 9's statutory rate — beer removed beyond the 60,000 bbl reduced tier. */
export const TTB_TIER_16_RATE_USD = 16;

/** Line 10's statutory rate — beer not eligible for any reduced rate. */
export const TTB_TIER_18_RATE_USD = 18;

/**
 * Barrels removed per calendar year above which the reduced rate stops
 * applying. Not used to split the tiers today (this brewery is far below it);
 * it backs the `computeTtbFigures` guard that refuses to keep quietly
 * reporting everything on Line 8 if that ever stops being true.
 */
export const TTB_REDUCED_TIER_LIMIT_BBL = 60_000;

/** Convert a USD-per-barrel rate to micro-dollars-per-barrel (rounded once). */
export function usdToMicrosPerBbl(usd: number): number {
  return Math.round(usd * 1_000_000);
}

/** `TTB_REDUCED_RATE_USD_FALLBACK` in micro-dollars per barrel. */
export const TTB_REDUCED_RATE_MICROS_FALLBACK = usdToMicrosPerBbl(TTB_REDUCED_RATE_USD_FALLBACK);

/**
 * The return serial number (Line 1), in this brewery's declared format
 * `TR-<year>-<quarter>` — e.g. `TR-2026-3` for the quarter beginning
 * 2026-07-01. Derived from the period rather than stored as a counter so a
 * recompute, a re-open or a backfilled period can never mint a duplicate or
 * skip a number.
 *
 * `periodStart` is a YYYY-MM-DD string (the filing period's first day).
 */
export function ttbSerialNumber(periodStart: string): string {
  const [year, month] = periodStart.split("-").map(Number);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    throw new Error(`ttbSerialNumber: unparseable period start "${periodStart}"`);
  }
  return `TR-${year}-${Math.floor((month - 1) / 3) + 1}`;
}

/** `"Q3 2026"` — Line 3b's human-readable period label, from the period's first day. */
export function ttbPeriodLabel(periodStart: string): string {
  const [year, month] = periodStart.split("-").map(Number);
  return `Q${Math.floor((month - 1) / 3) + 1} ${year}`;
}

/** The number of Schedule A rows on page 1 of the form. Pages 3-4 (the continuation sheets) are deliberately not modelled. */
export const SCHEDULE_A_ROWS = 5;

export const TTB_REFERENCE: ReferenceSpec = {
  tables: [
    {
      title: "Federal Beer Excise Rates (26 U.S.C. 5051)",
      columns: ["Rate", "Applies to", "Form line"],
      rows: [
        ["$3.50 per barrel", "First 60,000 bbl removed per calendar year, by a brewer producing under 2,000,000 bbl", "Line 8"],
        ["$16.00 per barrel", "Removals beyond the reduced tier, up to 6,000,000 bbl", "Line 9"],
        ["$18.00 per barrel", "Beer not eligible for a reduced rate", "Line 10"],
      ],
    },
  ],
  notes: [
    "TTB F 5130.Pilot-B combines the excise tax return (formerly TTB F 5000.24) and the Brewer's Report of Operations (formerly TTB F 5130.9) into one filing — see TTB Industry Circular 2025-1.",
    "Quarterly filing; the return and full payment are due 14 days after the end of the quarter.",
    "Taxable barrels are ALL removals for consumption or sale, across every shipment channel. Unlike NC Form B-C-710, wholesale removals are not excluded federally — the brewery pays the tax on removal regardless of who buys it.",
    "The only federal exclusions are removals without payment of tax: exports (Line 34) and transfers in bond (Line 35). Neither is a shipment channel, so both are manual entry.",
    "Lines 9 and 10 are always zero at this brewery's volume. The worksheet warns rather than silently reallocating if annual removals ever approach 60,000 barrels.",
    "Reporting method: beer produced is reported equal to beer removed, and beer on hand at period end (Line 44) is zero by construction. Lines 28-44 are therefore fully derived, with no manual inventory entry.",
    "Schedule A is modelled for the 5 rows printed on page 1 only. The page 3-4 continuation sheets are not modelled; overflow must be attached separately.",
    "Semimonthly Form 5130.Pilot-A is not filed here, so Line 42a is always zero.",
  ],
};
