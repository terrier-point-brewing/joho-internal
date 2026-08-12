/**
 * TTB F 5130.Pilot-B worksheet field ownership — the SINGLE source of truth
 * for which worksheet keys are server-computed (read-only on the worksheet;
 * always overwritten by a recompute) vs. manually entered (preserved by
 * `mergeWorksheet` across a recompute).
 *
 * Deliberately zero server imports — only `./rates` (constants) and
 * `@/lib/tax/types` (types, erased at compile time). This lets it be imported
 * by BOTH:
 *  - `./template.ts` (server), which wraps `resolveTtbFieldOwnership` in the
 *    `Proxy` that backs `TaxPartyTemplate.fieldOwnership`.
 *  - `app/finance/tax/parties/TtbBeerExcise/fieldOwnership.ts` (client, thin
 *    re-export), which the worksheet UI uses to decide read-only vs. editable.
 * Do NOT import `./calc.ts` here — it dynamically imports the Supabase admin
 * client, which a client-importable module must never pull in.
 *
 * Note how much of this form is computed: the whole of Lines 28-44 is derived
 * from the reporting method (produced = removed, nothing on hand at period
 * end), so the operations half of the return needs no data entry at all.
 */
import type { FieldOwnership } from "@/lib/tax/types";
import { SCHEDULE_A_ROWS } from "./rates";
import { increasingRowKeys } from "./derive";

const COMPUTED_KEYS = new Set<string>([
  // Header (Lines 1, 3a-3c) — derived from the filing period, never typed.
  "serial_number",
  "reporting_year",
  "period_label",
  "period_start",
  "period_end",

  // Removals from the shipment feed.
  "bbl_distribution",
  "bbl_contract",
  "bbl_taproom",
  "bbl_wholesale",
  "bbl_total_removals",
  "bbl_removals_without_tax_total",

  // Lines 8-15 — excise tax calculation.
  "ttb_reduced_rate_micros",
  "bbl_rate_reduced",
  "bbl_rate_16",
  "bbl_rate_18",
  "cents_tax_reduced",
  "cents_tax_16",
  "cents_tax_18",
  "bbl_total_taxable",
  "cents_total_tax",
  "cents_increasing_adjustments",
  "cents_gross_due",
  "cents_decreasing_adjustments",
  "cents_amount_due",

  // Lines 20, 23, 27 — Schedule A subtotals.
  "cents_increasing_tax_due",

  // Lines 28-44 — brewery operations, fully derived (see the file header).
  "bbl_opening",
  "bbl_produced",
  "bbl_total_available",
  "bbl_available_recon",
  "bbl_pilot_a_removals",
  "bbl_taxpaid_removals_total",
  "bbl_other_subtractions",
  "bbl_ending",

  // Line 46 — answered from the contract_brewing channel.
  "flag_contract_removals",

  // Line 8's reduced-rate eligibility attestation. Computed and locked: this
  // brewery produces the beer it removes, so the checkbox is never a judgment
  // call a filer should be able to get wrong.
  "flag_reduced_rate_eligible",

  // Schedule A per-row tax due (column f) = quantity x rate.
  ...Array.from({ length: SCHEDULE_A_ROWS }, (_, i) => increasingRowKeys(i + 1).cents),
]);

/** Resolve ownership for a worksheet field key. Unrecognized keys default to "manual". */
export function resolveTtbFieldOwnership(key: string): FieldOwnership {
  return COMPUTED_KEYS.has(key) ? "computed" : "manual";
}

/** True if `key` is server-computed (read-only in the worksheet UI). */
export function isComputedField(key: string): boolean {
  return resolveTtbFieldOwnership(key) === "computed";
}
