/**
 * TTB F 5130.Pilot-B — the SINGLE, pure figure derivation shared by every
 * caller so the displayed worksheet can never drift from what the server saves.
 *
 * Given a worksheet field set (computed channel barrels + manual removals /
 * Schedule A / payment fields) it re-derives, in one place:
 *   - Lines 8-15  the excise tax calculation
 *   - Lines 16-27 Schedule A's two adjustment subtotals
 *   - Lines 28-44 the brewery operations / inventory reconciliation
 *   - Line 46     the contract-removals answer
 *
 * Used identically by:
 *   - `./calc.ts`     → `computeTtbFigures` (initial shipments compute)
 *   - `./template.ts` → `mergeWorksheet` (server recompute + manual-edit merge)
 *   - `@/lib/tax/ttbExciseWorksheetMath` → the client's live-edit recompute
 *
 * Deliberately zero server imports — only `./rates` (statutory constants) and
 * `@/lib/tax/types` (types, erased at compile time).
 *
 * UNITS. Barrels are numbers rounded to 2 decimal places (TTB reports
 * fractional barrels; `export_transactions.volume_bbl` is already fractional,
 * so unlike the NC worksheet there is no whole-unit rounding). Money is
 * integer cents. Adjustment rates are micro-dollars per unit. Every rounding
 * uses `Math.round` exactly once at its point of definition.
 *
 * THE INVENTORY MODEL. This brewery reports beer produced equal to beer
 * removed and carries no beer on hand between periods — an accepted
 * simplification at this scale. That is expressed here as a derivation, not a
 * hardcoded zero: Line 29 (produced) is solved for the value that makes Line
 * 44 (on hand at end) come out to zero given everything else on the form. So
 * if a real export, in-bond transfer or loss is ever entered, produced rises
 * to match and the reconciliation still closes — it does not silently
 * mis-state the return. `./calc.ts` raises a warning in that case so a human
 * looks at it.
 */
import type { WorksheetFields } from "@/lib/tax/types";
import { SCHEDULE_A_ROWS, TTB_REDUCED_RATE_MICROS_FALLBACK } from "./rates";

const num = (v: number | string | null | undefined) => Number(v ?? 0);

/** Round a barrel figure to the 2 decimal places TTB reports. */
export function roundBbl(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Worksheet field keys for one Schedule A increasing-adjustment row (Lines 16-19). */
export function increasingRowKeys(index: number) {
  return {
    type: `sch_a_inc_${index}_type`,
    info: `sch_a_inc_${index}_info`,
    unit: `sch_a_inc_${index}_unit`,
    quantity: `sch_a_inc_${index}_quantity`,
    rateMicros: `sch_a_inc_${index}_rate_micros`,
    cents: `sch_a_inc_${index}_cents`,
  } as const;
}

/** Worksheet field keys for one Schedule A decreasing-adjustment row (Lines 24-26). */
export function decreasingRowKeys(index: number) {
  return {
    type: `sch_a_dec_${index}_type`,
    info: `sch_a_dec_${index}_info`,
    claimCents: `sch_a_dec_${index}_claim_cents`,
    balanceCents: `sch_a_dec_${index}_balance_cents`,
    amountCents: `sch_a_dec_${index}_amount_cents`,
  } as const;
}

/**
 * The shared derivation. Returns a NEW field set with every computed key
 * re-derived from the channel barrels + manual fields; unrecognized keys pass
 * through unchanged. Runs identically server-side and client-side.
 */
export function deriveTtbFigures(fields: WorksheetFields): WorksheetFields {
  const f: WorksheetFields = { ...fields };

  // ── Removals from the shipment feed ──────────────────────────────────────
  //
  // Every channel is a taxable federal removal (see ./rates.ts's header for
  // why this differs from Form B-C-710).
  const bblDistribution = num(f.bbl_distribution);
  const bblContract = num(f.bbl_contract);
  const bblTaproom = num(f.bbl_taproom);
  const bblWholesale = num(f.bbl_wholesale);
  const bblRemovals = roundBbl(bblDistribution + bblContract + bblTaproom + bblWholesale);
  f.bbl_total_removals = bblRemovals;

  // ── L34-37 Removals without payment of tax ───────────────────────────────
  //
  // Manual: `export_transactions` has no export / in-bond channel, so nothing
  // in the feed can populate these.
  const bblExports = num(f.bbl_exports_without_tax);
  const bblInBond = num(f.bbl_transfers_in_bond);
  const bblOtherUntaxed = num(f.bbl_other_removals_without_tax);
  const bblUntaxedTotal = roundBbl(bblExports + bblInBond + bblOtherUntaxed);
  f.bbl_removals_without_tax_total = bblUntaxedTotal;

  // ── L8-11 Excise tax calculation ─────────────────────────────────────────
  //
  // Taxable removals = everything shipped, less the untaxed removals above,
  // floored at 0. Tiers 9 and 10 are structurally zero at this brewery's
  // volume; they are still derived (rather than omitted) so the form's
  // arithmetic is complete and a future tier split has somewhere to land.
  const bblTaxable = roundBbl(Math.max(0, bblRemovals - bblUntaxedTotal));
  f.bbl_rate_reduced = bblTaxable;
  f.bbl_rate_16 = 0;
  f.bbl_rate_18 = 0;

  const rateMicros = num(f.ttb_reduced_rate_micros) || TTB_REDUCED_RATE_MICROS_FALLBACK;
  // rateMicros/10000 converts micro-dollars per barrel to cents per barrel.
  const centsReduced = Math.round((bblTaxable * rateMicros) / 10000);
  f.cents_tax_reduced = centsReduced;
  f.cents_tax_16 = 0;
  f.cents_tax_18 = 0;

  f.bbl_total_taxable = bblTaxable;
  const centsTotalTax = centsReduced;
  f.cents_total_tax = centsTotalTax;

  // ── L16-23 Schedule A, increasing adjustments ────────────────────────────
  //
  // Each row's tax due (column f) is quantity x rate, derived rather than
  // typed, so the row and the subtotal can never disagree. L20 is the sum of
  // the rows; L21/L22 (interest, penalties) are manual; L23 is their total.
  let centsIncreasingRows = 0;
  for (let i = 1; i <= SCHEDULE_A_ROWS; i += 1) {
    const keys = increasingRowKeys(i);
    const rowCents = Math.round((num(f[keys.quantity]) * num(f[keys.rateMicros])) / 10000);
    f[keys.cents] = rowCents;
    centsIncreasingRows += rowCents;
  }
  f.cents_increasing_tax_due = centsIncreasingRows;

  const centsIncreasingTotal = centsIncreasingRows + num(f.cents_interest) + num(f.cents_penalties);
  f.cents_increasing_adjustments = centsIncreasingTotal;

  // ── L24-27 Schedule A, decreasing adjustments ────────────────────────────
  //
  // Column (e) "amount of adjustment this period" is what the filer claims,
  // so it is manual; only the subtotal is derived.
  let centsDecreasingTotal = 0;
  for (let i = 1; i <= SCHEDULE_A_ROWS; i += 1) {
    centsDecreasingTotal += num(f[decreasingRowKeys(i).amountCents]);
  }
  f.cents_decreasing_adjustments = centsDecreasingTotal;

  // ── L12-15 Back on page 1 ────────────────────────────────────────────────
  f.cents_gross_due = centsTotalTax + centsIncreasingTotal;
  f.cents_amount_due = num(f.cents_gross_due) - centsDecreasingTotal;

  // ── L28-44 Brewery operations ────────────────────────────────────────────
  //
  // L28 opening is the prior return's L44, which this reporting method holds
  // at zero. It is computed rather than manual so the two can never disagree;
  // `./calc.ts` warns if a prior period ever leaves a non-zero balance.
  const bblOpening = 0;
  f.bbl_opening = bblOpening;

  const bblReceivedInBond = num(f.bbl_received_in_bond);
  const bblReturned = num(f.bbl_returned_after_removal);
  const bblOverage = num(f.bbl_inventory_overage);

  const bblConsumedDestroyed = num(f.bbl_consumed_or_destroyed);
  const bblLosses = num(f.bbl_losses);
  const bblShortage = num(f.bbl_inventory_shortage);

  // L42a — semimonthly Form 5130.Pilot-A is not filed here.
  f.bbl_pilot_a_removals = 0;
  const bblTaxpaidRemovals = roundBbl(bblTaxable + num(f.bbl_pilot_a_removals));
  f.bbl_taxpaid_removals_total = bblTaxpaidRemovals;

  // L43 — everything leaving inventory other than taxpaid removals.
  const bblOtherSubtractions = roundBbl(bblUntaxedTotal + bblConsumedDestroyed + bblLosses + bblShortage);
  f.bbl_other_subtractions = bblOtherSubtractions;

  // L29 — produced. Solved so that L44 lands on zero: everything that leaves
  // inventory this period must have entered it this period. See the file
  // header on why this is a derivation and not a hardcoded mirror of L11.
  const bblProduced = roundBbl(
    Math.max(0, bblTaxpaidRemovals + bblOtherSubtractions - bblOpening - bblReceivedInBond - bblReturned - bblOverage),
  );
  f.bbl_produced = bblProduced;

  // L33 / L41 — total available.
  const bblAvailable = roundBbl(bblOpening + bblProduced + bblReceivedInBond + bblReturned + bblOverage);
  f.bbl_total_available = bblAvailable;
  f.bbl_available_recon = bblAvailable;

  // L44 — on hand at end of period. Zero whenever L29 was solvable; a positive
  // value can only appear if additions exceed removals (e.g. a large in-bond
  // receipt), in which case it must carry into the next period's L28 and
  // `./calc.ts` raises a warning.
  f.bbl_ending = roundBbl(bblAvailable - bblTaxpaidRemovals - bblOtherSubtractions);

  // ── L8 Reduced-rate eligibility ──────────────────────────────────────────
  //
  // The checkbox reads "I (or another brewery in my controlled group) produced
  // this beer and I am eligible for this rate." This brewery produces every
  // barrel it removes — including the contract_brewing channel, where it is
  // the producing brewer removing beer made for someone else — so the answer
  // is always yes. Computed rather than manual so it can't be mis-answered.
  f.flag_reduced_rate_eligible = 1;

  // ── L46 Contract removals ────────────────────────────────────────────────
  //
  // Answered from the feed: any barrel shipped on the `contract_brewing`
  // channel is beer removed and taxpaid under a contract arrangement.
  f.flag_contract_removals = bblContract > 0 ? 1 : 0;

  return f;
}
