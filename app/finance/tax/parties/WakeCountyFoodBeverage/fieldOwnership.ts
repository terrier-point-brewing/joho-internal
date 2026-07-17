/**
 * Client-side re-export of the Wake County F&B field-ownership rule. The single
 * source of truth is the pure lib/tax/parties/wakeCountyFoodBeverage/
 * fieldOwnership.ts module (zero server imports), so the client bundle and the
 * server template resolve ownership identically.
 */
export {
  resolveWakeFieldOwnership,
  isComputedField,
} from "@/lib/tax/parties/wakeCountyFoodBeverage/fieldOwnership";

/** Reads Tax Owed (cents) off a worksheet's fields. `null` before anything's been computed. */
export function getTotalDueCents(fields: Record<string, number | string | null>): number | null {
  const v = fields.wake_tax_owed_cents;
  return v == null ? null : Number(v);
}
