/**
 * Client-side re-export of the TTB F 5130.Pilot-B worksheet field-ownership
 * rule.
 *
 * The single source of truth is the pure `lib/tax/parties/ttbBeerExcise/
 * fieldOwnership.ts` module (zero server imports — no `registerParty`
 * side-effect registration, no Supabase-admin code path), so both this client
 * bundle and the server-side `template.ts` (which wraps the same
 * `resolveTtbFieldOwnership` in a `Proxy`) resolve ownership identically and
 * can never drift apart.
 */
export { resolveTtbFieldOwnership, isComputedField } from "@/lib/tax/parties/ttbBeerExcise/fieldOwnership";

/** Reads Line 15 (Amount Due With This Return) in cents off a worksheet's fields. `null` before anything's been computed. */
export function getTotalDueCents(fields: Record<string, number | string | null>): number | null {
  const v = fields.cents_amount_due;
  return v == null ? null : Number(v);
}
