/**
 * Client-side NC DOR worksheet field facts: which fields are server-computed
 * (rendered read-only in the worksheet) vs. manually entered, and which field
 * carries the bottom-line total the shell's totals footer displays.
 *
 * Mirrors `resolveFieldOwnership` in
 * `lib/tax/parties/ncDorSalesUse/template.ts` (the server-side source of
 * truth `mergeWorksheet` uses to decide what a recompute overwrites vs.
 * preserves). Duplicated here — rather than importing the party template
 * module — so this client bundle doesn't pull in `registerParty`'s
 * side-effect registration or the calc engine's Supabase-admin code path.
 * `GET /api/tax/parties` doesn't expose `fieldOwnership` (see Task 17 brief),
 * so the worksheet component owns this knowledge itself. Keep in sync with
 * `template.ts` if a line's ownership ever changes.
 */
import { RATE_LINES } from "@/lib/tax/parties/ncDorSalesUse/calc";

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
 * True if `key` is server-computed (read-only in the worksheet UI). Defaults
 * to `false` (manual/editable) for any unrecognized key — the safe default,
 * matching the server's `resolveFieldOwnership` fallback.
 */
export function isComputedField(key: string): boolean {
  if (STATIC_COMPUTED_KEYS.has(key)) return true;
  if (STATIC_MANUAL_KEYS.has(key)) return false;
  if (key.startsWith("county_")) return true;

  const match = RATE_LINE_KEY_RE.exec(key);
  if (match && RATE_LINE_NUMBERS.has(Number(match[1]))) {
    return match[2] !== "purchases";
  }
  return false;
}

/** Reads Line 21 (Total Due) in cents off a worksheet's fields. `null` before anything's been computed. */
export function getTotalDueCents(fields: Record<string, number | string | null>): number | null {
  const v = fields.line21_total_due;
  return v == null ? null : Number(v);
}
