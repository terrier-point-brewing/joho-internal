/**
 * Square processing fees, per payment, from the one API that reports them.
 *
 * ── Why the Payments API and nothing else ────────────────────────────────────
 * The orders feed's tenders carry no fee at all (verified: zero
 * `processing_fee_money` across every stored order), and the payouts feed
 * nets fees away before reporting (payouts.ts: gross − fees == payout, to the
 * cent). `GET /payments` is the only surface that itemizes the fee, as
 * `processing_fee[]` entries on each payment. Fees post to a payment up to a
 * day after the payment itself, so a payment fetched too eagerly can carry an
 * empty fee array that fills in later — which is why the sync re-walks a
 * trailing window instead of fetching each day once.
 *
 * ── COMPLETED only ───────────────────────────────────────────────────────────
 * A canceled or failed payment keeps its record but its fee never settles;
 * counting it would invent cost. Refunded payments KEEP their processing fee
 * (Square does not return fees on refunds since 2019), so no refund netting
 * belongs here.
 */
import { squareGetAll, squareLocationId } from "./client";

interface RawPayment {
  id: string;
  status?: string;
  created_at?: string;
  total_money?: { amount?: number };
  processing_fee?: { amount_money?: { amount?: number } }[];
}

export interface PaymentFee {
  paymentId: string;
  /** Eastern local "YYYY-MM-DD" — the sale's business day. */
  paymentDate: string;
  /** Cents Square kept. Positive. */
  feeCents: number;
  totalCents: number;
}

/** UTC RFC 3339 → Eastern local date, same convention as lib/square/payroll.ts. */
function toEasternDate(utcStr: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(utcStr));
}

/**
 * Every COMPLETED payment's fee in [startDate, endDate] (Eastern days,
 * inclusive). The API window is UTC created_at, so it is padded a day each
 * side and re-filtered here on the Eastern date — the same edge the payouts
 * fetch guards with its arrival-date filter.
 */
export async function fetchPaymentFees(startDate: string, endDate: string): Promise<PaymentFee[]> {
  const beginUtc = new Date(`${startDate}T00:00:00.000Z`);
  beginUtc.setUTCDate(beginUtc.getUTCDate() - 1);
  const endUtc = new Date(`${endDate}T23:59:59.000Z`);
  endUtc.setUTCDate(endUtc.getUTCDate() + 1);

  const payments = await squareGetAll<RawPayment>("/payments", "payments", {
    location_id: squareLocationId(),
    begin_time: beginUtc.toISOString(),
    end_time: endUtc.toISOString(),
    sort_order: "ASC",
  });

  const fees: PaymentFee[] = [];
  for (const p of payments) {
    if (p.status !== "COMPLETED" || !p.created_at) continue;
    const paymentDate = toEasternDate(p.created_at);
    if (paymentDate < startDate || paymentDate > endDate) continue;
    const feeCents = (p.processing_fee ?? []).reduce((sum, f) => sum + (f.amount_money?.amount ?? 0), 0);
    // A completed cash payment has no fee: recorded at 0 rather than skipped,
    // so a re-synced day REPLACES what it knew — a card payment whose fee had
    // not posted yet gets its 0 corrected on the next pass instead of the
    // absence being indistinguishable from "never fetched".
    fees.push({ paymentId: p.id, paymentDate, feeCents, totalCents: p.total_money?.amount ?? 0 });
  }
  return fees;
}
