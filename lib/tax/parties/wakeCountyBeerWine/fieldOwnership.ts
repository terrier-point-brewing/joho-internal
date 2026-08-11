/**
 * Wake County Beer & Wine worksheet field ownership — the single source of
 * truth for which worksheet keys are server-computed. Every field is computed
 * from the schedule's selected license types and the statutory fee schedule
 * (the worksheet has no manual inputs), so the whole set is read-only on the
 * worksheet and fully replaced by each recompute.
 *
 * Zero server imports — only @/lib/tax/types (erased at compile time) and the
 * pure ./rates module — so both the server ./template.ts (via its Proxy) and
 * the client re-export resolve ownership identically.
 */
import type { FieldOwnership } from "@/lib/tax/types";
import { BEER_WINE_LICENSE_TYPES, licenseFeeFieldKey } from "./rates";

const COMPUTED_KEYS = new Set<string>([
  ...BEER_WINE_LICENSE_TYPES.map((t) => licenseFeeFieldKey(t.value)),
  "wake_bw_license_count",
  "wake_bw_total_fee_cents",
]);

export function resolveWakeBeerWineFieldOwnership(key: string): FieldOwnership {
  return COMPUTED_KEYS.has(key) ? "computed" : "manual";
}

export function isComputedField(key: string): boolean {
  return resolveWakeBeerWineFieldOwnership(key) === "computed";
}
