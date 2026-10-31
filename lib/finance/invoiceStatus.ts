import type { InvoiceStatus } from "@/types/finance";

/**
 * Single source of truth for mapping a Square invoice status to our ledger
 * `InvoiceStatus`. Consolidates the previously-duplicated mappers in
 * syncSquareInvoices, the deposit route, and the export route so they never
 * drift. A fully-refunded invoice is `voided`; a partial refund stays `paid`
 * (the refunded dollars are tracked separately by the refund sync).
 */
/**
 * Square's "the customer has paid, the money has not arrived" state: an ACH or
 * bank transfer initiated against the invoice. The ledger status stays `open`
 * (no cash yet), but every screen that shows an open invoice should say the
 * payment is on its way rather than nag for it. Read from the Square status
 * the sync keeps in `invoices.raw_data.square_status`.
 */
export function isPaymentProcessing(squareStatus: string | null | undefined): boolean {
  return (squareStatus ?? "").toUpperCase() === "PAYMENT_PENDING";
}

/** What to call an invoice on screen: its ledger status, or "processing" while a payment is in flight. */
export function invoiceDisplayStatus(status: string, squareStatus: string | null | undefined): string {
  return status === "open" && isPaymentProcessing(squareStatus) ? "processing" : status;
}

export function mapSquareInvoiceStatus(squareStatus: string): InvoiceStatus {
  switch (squareStatus.toUpperCase()) {
    case "DRAFT":                       return "draft";
    case "UNPAID":
    case "SCHEDULED":
    // A payment (e.g. ACH/bank transfer) has been initiated but hasn't settled
    // yet. Treat as open/awaiting: it's accrual revenue but the cash hasn't
    // cleared, so it stays out of the cash-flow statement (which requires
    // 'paid') until Square reports PAID.
    case "PAYMENT_PENDING":             return "open";
    case "PARTIALLY_PAID":              return "partial";
    case "PAID":
    case "PARTIALLY_REFUNDED":          return "paid";
    case "CANCELED":
    case "REFUNDED":
    case "FAILED":                      return "voided";
    default:                            return "unknown";
  }
}
