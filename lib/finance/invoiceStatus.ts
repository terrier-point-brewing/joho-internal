import type { InvoiceStatus } from "@/types/finance";

/**
 * Single source of truth for mapping a Square invoice status to our ledger
 * `InvoiceStatus`. Consolidates the previously-duplicated mappers in
 * syncSquareInvoices, the deposit route, and the export route so they never
 * drift. A fully-refunded invoice is `voided`; a partial refund stays `paid`
 * (the refunded dollars are tracked separately by the refund sync).
 */
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
