/**
 * Wake County F&B worksheet field ownership — the single source of truth for
 * which worksheet keys are server-computed. Every field is computed (the
 * worksheet has no manual inputs), so the whole set is read-only on the
 * worksheet and fully replaced by each recompute.
 *
 * Zero server imports — only @/lib/tax/types (erased at compile time) — so both
 * the server ./template.ts (via its Proxy) and the client re-export resolve
 * ownership identically.
 */
import type { FieldOwnership } from "@/lib/tax/types";

const COMPUTED_KEYS = new Set([
  "wake_gross_receipts_cents",
  "wake_applicable_receipts_cents",
  "wake_tax_owed_cents",
  "wake_collected_fb_cents",
  "wake_rate",
]);

export function resolveWakeFieldOwnership(key: string): FieldOwnership {
  return COMPUTED_KEYS.has(key) ? "computed" : "manual";
}

export function isComputedField(key: string): boolean {
  return resolveWakeFieldOwnership(key) === "computed";
}
