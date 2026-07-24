/**
 * NC DOR Beer Excise Tax (Form B-C-710) — statutory rate + reference constants.
 *
 * Deliberately zero server imports so this stays importable by both the pure
 * `./fieldOwnership.ts`/`./derive.ts` modules (which must stay client-safe)
 * and the server `./calc.ts`/`./template.ts`.
 */
import type { ReferenceSpec } from "@/lib/tax/types";

/** Statutory NC malt-beverage excise rate, in dollars per gallon (form Line 6). */
export const NC_EXCISE_RATE_USD_PER_GALLON = 0.6171;

/** `usdToMicros(0.6171)` — the fallback used when the canonical `tax_rates` row (key `nc_dor_beer_excise`) is missing. */
export const NC_EXCISE_RATE_MICROS_FALLBACK = 617100;

/** Timely-filing discount applied to Line 6 (2%). */
export const DISCOUNT_RATE = 0.02;

/**
 * Channels that are taxable to TPB as a resident brewery (Line 5). Wholesale
 * sold to other NC wholesalers is a Line 4a deduction and is never taxed here.
 */
export const TAXABLE_CHANNELS: ReadonlySet<string> = new Set([
  "distribution",
  "contract_brewing",
  "taproom",
]);

/** The one non-taxable channel — routed to the Line 4a deduction instead. */
export const WHOLESALE_CHANNEL = "wholesale";

/**
 * True when channels `a` and `b` fall on opposite sides of the NC excise
 * treatment line — one taxable (Line 5), the other the wholesale deduction
 * (Line 4a). Used to warn when a billing-channel override crosses that boundary:
 * excise LIABILITY follows the stored shipment channel, so charging excise on an
 * off-model bill can desync from what TPB actually remits.
 */
export function crossesExciseTreatmentBoundary(a: string, b: string): boolean {
  return TAXABLE_CHANNELS.has(a) !== TAXABLE_CHANNELS.has(b);
}

/** Convert a USD-per-gallon rate to micro-dollars-per-gallon (rounded once). */
export function usdToMicros(usd: number): number {
  return Math.round(usd * 1_000_000);
}

export const BEER_EXCISE_REFERENCE: ReferenceSpec = {
  tables: [
    {
      title: "Rate",
      columns: ["Rate", "Applies to"],
      rows: [
        ["61.71¢ per gallon", "Taxable malt beverage gallons (Form B-C-710, Line 6)"],
        ["2% timely discount", "Applied to Line 6 when filed and paid timely (Line 7)"],
      ],
    },
  ],
  notes: [
    "Filed monthly; due the 15th of the following month.",
    "Taxable channels: distribution, contract brewing, and taproom sales.",
    "Wholesale sold to other NC wholesalers is a Line 4a deduction, never taxed.",
    "The rate is read from the canonical tax_rates row (key nc_dor_beer_excise); the statutory $0.6171/gal is used as a fallback only if that row is missing.",
  ],
};
