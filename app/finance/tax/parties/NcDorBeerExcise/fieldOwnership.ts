/**
 * Client-side re-export of the NC DOR Beer Excise worksheet field-ownership
 * rule.
 *
 * The single source of truth is the pure `lib/tax/parties/ncDorBeerExcise/
 * fieldOwnership.ts` module (zero server imports — no `registerParty`
 * side-effect registration, no Supabase-admin code path), so both this
 * client bundle and the server-side `template.ts` (which wraps the same
 * `resolveBeerFieldOwnership` in a `Proxy` for `mergeWorksheet`) resolve
 * ownership identically and can never drift apart.
 */
export { resolveBeerFieldOwnership, isComputedField } from "@/lib/tax/parties/ncDorBeerExcise/fieldOwnership";

/** Reads Line 11 (Total Payment Due) in cents off a worksheet's fields. `null` before anything's been computed. */
export function getTotalDueCents(fields: Record<string, number | string | null>): number | null {
  const v = fields.cents_total_payment_due;
  return v == null ? null : Number(v);
}
