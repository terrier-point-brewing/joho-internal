/**
 * Client-side re-export of the NC DOR worksheet field-ownership rule.
 *
 * The single source of truth is the pure `lib/tax/parties/ncDorSalesUse/
 * fieldOwnership.ts` module (zero server imports — no `registerParty`
 * side-effect registration, no Supabase-admin code path), so both this
 * client bundle and the server-side `template.ts` (which wraps the same
 * `resolveFieldOwnership` in a `Proxy` for `mergeWorksheet`) resolve
 * ownership identically and can never drift apart.
 */
export { resolveFieldOwnership, isComputedField } from "@/lib/tax/parties/ncDorSalesUse/fieldOwnership";

/** Reads Line 21 (Total Due) in cents off a worksheet's fields. `null` before anything's been computed. */
export function getTotalDueCents(fields: Record<string, number | string | null>): number | null {
  const v = fields.line21_total_due;
  return v == null ? null : Number(v);
}
