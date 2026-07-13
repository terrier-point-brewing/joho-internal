/**
 * NC DOR Beer Excise (Form B-C-710) — the SINGLE, pure figure derivation
 * shared by every caller so the displayed worksheet can never drift from
 * what the server saves.
 *
 * Given a worksheet field set (computed channel gallons + manual inventory
 * / deduction / penalty / interest fields) it re-derives, in one place, the
 * full Line 2–11 waterfall (see file header math in the implementation plan).
 *
 * Used identically by:
 *   - `./calc.ts`      → `computeBeerExciseFigures` (initial shipments compute)
 *   - `./template.ts`  → `mergeWorksheet` (server recompute + manual-edit merge)
 *   - `../../beerExciseWorksheetMath.ts` → `recomputeClientBeerTotals` (client live edit)
 *
 * Deliberately zero server imports — only `./rates` (statutory constants) and
 * `@/lib/tax/types` (types, erased at compile time). All money is integer
 * cents; gallons are integers; every rounding uses `Math.round` exactly once.
 */
import type { WorksheetFields } from "@/lib/tax/types";
import { NC_EXCISE_RATE_MICROS_FALLBACK, DISCOUNT_RATE } from "./rates";

const num = (v: number | string | null | undefined) => Number(v ?? 0);

/**
 * The shared derivation. Returns a NEW field set with every computed key
 * re-derived from the channel gallons + manual fields; unrecognized keys
 * pass through unchanged. Runs identically server-side and client-side.
 */
export function deriveBeerExciseFigures(fields: WorksheetFields): WorksheetFields {
  const f: WorksheetFields = { ...fields };

  const galDistribution = num(f.gal_distribution);
  const galContract = num(f.gal_contract);
  const galTaproom = num(f.gal_taproom);
  const galWholesale = num(f.gal_wholesale);

  // L2 — total gallons produced/received for sale across all channels.
  const galProducedForSale = galDistribution + galContract + galTaproom + galWholesale;
  f.gal_produced_for_sale = galProducedForSale;

  // L3 — total available = beginning inventory + L2.
  const galTotalAvailable = num(f.gal_beginning_inventory) + galProducedForSale;
  f.gal_total_available = galTotalAvailable;

  // L4a — allowable deductions: wholesale (never taxed) + any manual extra deduction.
  const galAllowableDeductions = galWholesale + num(f.gal_deduction_other);
  f.gal_allowable_deductions = galAllowableDeductions;

  // L5 — taxable gallons: total available less all deductions/adjustments, floored at 0.
  const galTaxable = Math.max(
    0,
    galTotalAvailable -
      galAllowableDeductions -
      num(f.gal_adjustments_part3) -
      num(f.gal_military_part4) -
      num(f.gal_ending_inventory),
  );
  f.gal_taxable = galTaxable;

  // Rate — live micros if present, else the statutory fallback.
  const rateMicros = num(f.nc_excise_rate_micros) || NC_EXCISE_RATE_MICROS_FALLBACK;

  // L6 — excise due: rateMicros/10000 converts micro-dollars/gal to cents/gal.
  const centsExciseDue = Math.round((galTaxable * rateMicros) / 10000);
  f.cents_excise_due = centsExciseDue;

  // L7 — 2% timely-filing discount.
  const centsDiscount = num(f.flag_timely) ? Math.round(centsExciseDue * DISCOUNT_RATE) : 0;
  f.cents_discount = centsDiscount;

  // L8 — net tax due.
  const centsNetTaxDue = centsExciseDue - centsDiscount;
  f.cents_net_tax_due = centsNetTaxDue;

  // L11 — total payment due.
  f.cents_total_payment_due = centsNetTaxDue + num(f.cents_penalty) + num(f.cents_interest);

  return f;
}
