/**
 * Client-side re-export of the Wake County Beer & Wine field-ownership rule.
 * The single source of truth is the pure lib/tax/parties/wakeCountyBeerWine/
 * fieldOwnership.ts module (zero server imports), so the client bundle and the
 * server template resolve ownership identically.
 */
export {
  resolveWakeBeerWineFieldOwnership,
  isComputedField,
} from "@/lib/tax/parties/wakeCountyBeerWine/fieldOwnership";

/** Reads the total renewal fee (cents) off a worksheet's fields. `null` before anything's been computed. */
export function getTotalDueCents(fields: Record<string, number | string | null>): number | null {
  const v = fields.wake_bw_total_fee_cents;
  return v == null ? null : Number(v);
}
