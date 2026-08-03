// lib/square/pushGate.ts
//
// One switch for every cold-storage → Square inventory write.
//
// OFF as of 2026-08-03. The push is planned, measured and reported, but nothing
// is sent to Square.
//
// Why: the mapping layer spent nine days pointed at a deleted variation. Square
// accepts a PHYSICAL_COUNT against an unknown object without returning an error,
// and the reconciler only checked that error field, so 1,040 writes were
// journalled as applied while Square's count never moved. Repairing those links
// re-armed the push against SKUs whose two sides are known to disagree with no
// agreed answer yet — Epic Hazy reads 111 in Square against 158 in cold storage,
// and that gap is deliberately not being reconciled by either side.
//
// Turning this on makes cold storage overwrite Square. Do it only once the drift
// view shows the two sides agreeing, or once someone has decided which side is
// right for the ones that don't. Everything downstream of the gate — write
// verification, journalling, per-SKU thresholds — is already in place and
// exercised by tests; the gate is the last thing to flip, not the first.
export const PUSH_TO_SQUARE_ENABLED = false;

/** Drift below this is left alone — rounding and in-flight sales, not a real gap. */
export const DRIFT_THRESHOLD = 0.5;

/**
 * Whether a Square-raised invoice may drain cold storage on its own.
 *
 * OFF as of 2026-08-03, for a different reason than the push above: this one
 * writes to the APP's ledger, not Square's. Booking a shipment that never
 * happened removes stock that is still on the shelf, and unlike a Square count
 * there is no second system to notice.
 *
 * Every invoice in prod carrying beer lines currently has an Export Bay shipment
 * behind it, so there is nothing waiting to be booked and nothing lost by
 * leaving this shut. Turn it on once a real case has appeared and a person has
 * confirmed the guards caught it correctly.
 */
export const INVOICE_WRITEBACK_ENABLED = false;
