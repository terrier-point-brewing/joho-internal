/**
 * The calendar day an invoice was paid, for as-at receivables.
 *
 * ── Why the payment's date and not the invoice's ─────────────────────────────
 * Square's invoice carries no "paid on". Its `updated_at` is the obvious stand-
 * in and is wrong in the one way that matters at a month end: these invoices
 * are paid by bank transfer, and Square only flips the invoice to PAID when the
 * transfer SETTLES, several days after the customer paid. An invoice paid on
 * 29 May reads `updated_at` 2 June -- so by that field it was still owed on
 * 31 May, which it was not. A later partial refund moves `updated_at` again.
 *
 * The order's tender is created the moment the customer pays, and never moves.
 * Checked against the four month ends an owner had stated by hand (May-Aug
 * 2026): the tender date reproduces three exactly, and on the fourth it found
 * an invoice the hand count had missed.
 *
 * ── A date, not a timestamp ──────────────────────────────────────────────────
 * The only question asked of it is "on or before this month end?", and that is
 * a question about the brewery's calendar. A payment at 9pm on the 30th in
 * Holly Springs is 1am on the 1st in UTC; storing the local day settles that
 * once, here, instead of in every comparison.
 */
import type { InvoiceStatus } from "@/types/finance";
import { localDateString } from "@/lib/utils/datetime";

/** The slice of a Square order tender this needs. */
export interface PaidOnTender {
  created_at?: string;
}

/**
 * The brewery-local day the invoice was paid, or null when it is not paid.
 *
 * Only a `paid` ledger status yields a date. A transfer that has been started
 * but not settled leaves the invoice `open` (see mapSquareInvoiceStatus), and a
 * date recorded then would have to be taken back if the transfer failed; once
 * it settles, this returns the day the customer actually paid.
 *
 * The LATEST tender is used, so an invoice settled in instalments counts as
 * owed until the last of them.
 *
 * `fallback` is for a paid invoice whose order shows no tender -- not seen in
 * practice, but a paid invoice with no date would silently never count as owed
 * in any month, so the invoice's own last-updated time is used instead of
 * nothing.
 */
export function invoicePaidOn(
  ledgerStatus: InvoiceStatus,
  tenders: PaidOnTender[] | null | undefined,
  fallback?: string | null,
): string | null {
  if (ledgerStatus !== "paid") return null;

  const stamps = (tenders ?? [])
    .map((t) => t.created_at)
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .sort();
  const latest = stamps[stamps.length - 1] ?? fallback ?? null;
  return latest ? localDateString(latest) : null;
}
