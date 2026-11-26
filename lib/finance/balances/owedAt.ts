/**
 * "Was this still owed on the month end?" -- the one definition, for both
 * directions, shared by every reader that asks.
 *
 * Two readers ask each question: the balance providers (GL 1100 and GL 2000,
 * providers/accruals.ts) and the bookkeeper export, which lists the invoices
 * and bills behind those two figures. They used to carry a copy of the filter
 * each. A list that disagrees with its own total is worse than either being
 * wrong, so the filter lives here and both import it.
 *
 * ── The rule: follow the money, not the status ───────────────────────────────
 * A receivable stops being owed when the money ARRIVES, and a payable stops
 * being owed when the money LEAVES. Neither is when the paperwork says "paid":
 *
 *   A partner pays an invoice by bank transfer on the 30th. Square marks the
 *   customer as having paid that day (`paid_on`) and the money reaches the
 *   Square balance on the 3rd (`funds_received_on`).
 *
 *   Ramp mails a rent check on the 18th and takes the money out of the wallet
 *   that day (`payment_sent_on`). The bill reads PAID when the landlord cashes
 *   it, two or three weeks later (`settled_at`).
 *
 * Dating either one by its status leaves a month end between the two days out
 * of balance by the whole amount: the cash account has already moved, or not
 * yet moved, and the receivable or payable says the opposite. Those two were
 * the largest items in every balancing difference traced from June to October
 * 2026 (rent: -$6,690 to -$7,259 a month; partner transfers: -$8,669.76 at
 * 31 October). Dated by the money, both sides of the entry move on the same day.
 *
 * Each rule falls back to the status date when the money date is unknown, so a
 * row the sync has not yet re-dated behaves exactly as it did before.
 */

/** The first instant after `periodEnd`'s calendar day, UTC -- for comparing a timestamptz against a month end. */
export function dayAfterIso(periodEnd: string): string {
  const d = new Date(`${periodEnd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

/**
 * PostgREST `.or()` filter: an invoice not yet collected at `periodEnd`.
 *
 * Still open, or paid with the money landing after the month end. A paid
 * invoice with no `funds_received_on` is judged on `paid_on` instead, and one
 * with neither date is treated as collected before any month end -- imported
 * history the Square sync does not own, where assuming "still owed" would
 * resurrect receivables settled long ago.
 */
export function invoiceOwedAtFilter(periodEnd: string): string {
  return [
    "status.eq.open",
    `and(status.eq.paid,funds_received_on.gt.${periodEnd})`,
    `and(status.eq.paid,funds_received_on.is.null,paid_on.gt.${periodEnd})`,
  ].join(",");
}

/**
 * PostgREST `.or()` filter: a bill not yet paid out at `periodEnd`.
 *
 * `payment_sent_on` (a calendar day) wins when Ramp has released the payment;
 * otherwise `settled_at` (a timestamp) decides, as it always has. A bill with
 * neither is simply unpaid.
 *
 * `settled_at` is compared against the first instant AFTER the month end: a
 * bill paid at 14:46 on the 31st was paid IN the month, not after it.
 */
export function billOwedAtFilter(periodEnd: string): string {
  const after = dayAfterIso(periodEnd);
  return [
    `payment_sent_on.gt.${periodEnd}`,
    "and(payment_sent_on.is.null,settled_at.is.null)",
    `and(payment_sent_on.is.null,settled_at.gte.${after})`,
  ].join(",");
}
