/**
 * NC DOR Sales & Use worksheet field ownership — the SINGLE source of truth
 * for which worksheet keys are server-computed (read-only on the worksheet;
 * always overwritten by a recompute) vs. manually entered (preserved by
 * `mergeWorksheet` across a recompute).
 *
 * Deliberately zero server imports — only `./rates` (statutory constants)
 * and `@/lib/tax/types` (types, erased at compile time). This lets it be
 * imported by BOTH:
 *  - `./template.ts` (server), which wraps `resolveFieldOwnership` in the
 *    `Proxy` that backs `TaxPartyTemplate.fieldOwnership` and drives
 *    `mergeWorksheet`.
 *  - `app/finance/tax/parties/NcDorSalesUse/fieldOwnership.ts` (client,
 *    thin re-export), which the worksheet UI uses to decide read-only vs.
 *    editable rendering per field.
 * Do NOT import `./calc.ts` here — it dynamically imports the Supabase
 * admin client, which is fine for a server-only caller but is exactly what
 * a client-importable module must never pull in.
 */
import type { FieldOwnership } from "@/lib/tax/types";
import { RATE_LINES } from "./rates";

const STATIC_COMPUTED_KEYS = new Set([
  "line1_gross_receipts",
  "line13_total",
  "line15_total",
  "line21_total_due",
]);

const STATIC_MANUAL_KEYS = new Set([
  "line2_sales_for_resale",
  "line3_exempt",
  "line14_excess",
  "line16_penalty",
  "line17_interest",
  "line18_less_prepay",
  "line19_prepay_next",
  "line20_credit",
  "line20_credit_explanation",
]);

const RATE_LINE_NUMBERS: ReadonlySet<number> = new Set(RATE_LINES);
const RATE_LINE_KEY_RE = /^line(\d+)_(purchases|receipts|tax)$/;

/**
 * Resolve ownership for any worksheet field key by parsing its
 * prefix/suffix, rather than enumerating every county x suffix combination.
 * Falls back to "manual" for anything unrecognized — the safe default, since
 * a manual edit is preserved by `mergeWorksheet` while a missing "computed"
 * classification would just mean the recompute never overwrote it.
 */
export function resolveFieldOwnership(key: string): FieldOwnership {
  if (STATIC_COMPUTED_KEYS.has(key)) return "computed";
  if (STATIC_MANUAL_KEYS.has(key)) return "manual";
  if (key.startsWith("county_")) return "computed";

  const match = RATE_LINE_KEY_RE.exec(key);
  if (match && RATE_LINE_NUMBERS.has(Number(match[1]))) {
    return match[2] === "purchases" ? "manual" : "computed";
  }

  return "manual";
}

/** True if `key` is server-computed (read-only in the worksheet UI). */
export function isComputedField(key: string): boolean {
  return resolveFieldOwnership(key) === "computed";
}
