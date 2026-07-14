/**
 * NC DOR Beer Excise worksheet field ownership — the SINGLE source of truth
 * for which worksheet keys are server-computed (read-only on the worksheet;
 * always overwritten by a recompute) vs. manually entered (preserved by
 * `mergeWorksheet` across a recompute).
 *
 * Deliberately zero server imports — only `@/lib/tax/types` (types, erased at
 * compile time). This lets it be imported by BOTH:
 *  - `./template.ts` (server), which wraps `resolveBeerFieldOwnership` in the
 *    `Proxy` that backs `TaxPartyTemplate.fieldOwnership` and drives
 *    `mergeWorksheet`.
 *  - `app/finance/tax/parties/NcDorBeerExcise/fieldOwnership.ts` (client,
 *    thin re-export), which the worksheet UI uses to decide read-only vs.
 *    editable rendering per field.
 * Do NOT import `./calc.ts` here — it dynamically imports the Supabase
 * admin client, which is fine for a server-only caller but is exactly what
 * a client-importable module must never pull in.
 */
import type { FieldOwnership } from "@/lib/tax/types";

const COMPUTED_KEYS = new Set([
  "gal_distribution",
  "gal_contract",
  "gal_taproom",
  "gal_wholesale",
  "gal_produced_for_sale",
  "gal_total_available",
  "gal_allowable_deductions",
  "gal_taxable",
  "nc_excise_rate_micros",
  "cents_excise_due",
  "cents_discount",
  "cents_net_tax_due",
  "cents_total_payment_due",
]);

/** Resolve ownership for a worksheet field key. Unrecognized keys default to "manual". */
export function resolveBeerFieldOwnership(key: string): FieldOwnership {
  return COMPUTED_KEYS.has(key) ? "computed" : "manual";
}

/** True if `key` is server-computed (read-only in the worksheet UI). */
export function isComputedField(key: string): boolean {
  return resolveBeerFieldOwnership(key) === "computed";
}
