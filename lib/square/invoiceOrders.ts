// Invoice `metadata.type` values our own flow stamps onto the Square Order it
// creates (see `lib/square/square-invoices.ts` — `createInvoice`). Deposit and
// export invoices are wholesale/contract, never in-person taproom sales.
const INVOICE_METADATA_TYPES = new Set(["allocation-deposit", "export-invoice"]);

// Only the fields the check reads, so narrower order-shaped types (e.g. the
// day-bucket rows in `lib/square/inventory.ts`) can be passed directly.
type InvoiceOrderShape = {
  source?: { name?: string };
  metadata?: Record<string, string>;
};

/**
 * Is this Square order an invoice (wholesale / contract / export), as opposed
 * to an in-person taproom POS sale?
 *
 * Two shapes exist and BOTH must be caught:
 *  1. Square-native invoices carry `source.name === "Invoices"`.
 *  2. Our own invoice flow creates the Order via the Orders API first (so Square
 *     stamps `source.name` with the application name, e.g. "tpb-reporting", NOT
 *     "Invoices") and then attaches a Square invoice. The only reliable signal
 *     on these is the `metadata.type` we set at creation.
 *
 * Checking `source.name` alone (the old convention) misses shape #2, leaking
 * wholesale invoice revenue into taproom sales / net-sales / inventory metrics.
 */
export function isInvoiceOrder(order: InvoiceOrderShape): boolean {
  if ((order.source?.name ?? "") === "Invoices") return true;
  const metaType = order.metadata?.type;
  return metaType != null && INVOICE_METADATA_TYPES.has(metaType);
}
