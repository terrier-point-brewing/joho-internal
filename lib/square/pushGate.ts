// lib/square/pushGate.ts
//
// One switch for every cold-storage → Square inventory write.
//
// ON as of 2026-08-20, after seventeen drifting SKUs were adjudicated one at a
// time. It was OFF from 2026-08-03 until then.
//
// Why it was shut: the mapping layer spent nine days pointed at a deleted
// variation. Square accepts a PHYSICAL_COUNT against an unknown object without
// returning an error, and the reconciler only checked that error field, so 1,040
// writes were journalled as applied while Square's count never moved. Repairing
// those links re-armed the push against SKUs whose two sides were known to
// disagree with no agreed answer — Epic Hazy read 111 in Square against 158 in
// cold storage, and that gap was deliberately not reconciled by either side.
//
// Why it is open now. The condition below was met: someone decided which side is
// right for every SKU that did not agree. The drift measured on 2026-08-20 was
// 17 SKUs over threshold out of 61, with zero dead links, and it fell into three
// causes, all of which named cold storage as the correct side:
//
//   * Square decremented below zero — a Fortnight invoice took 20 Pace Yourself
//     1/6 kegs out of a stock of 5, and Oktoberfest 1/6 sat at −12. A negative
//     on-hand is not a count, so there was nothing to weigh cold storage against.
//   * Square never heard about production. This gate being shut is what caused
//     that: packaging runs stopped reaching Square on 2026-08-03 while sales and
//     invoices kept deducting. Groundhog Imperial Stout had no inventory change
//     in Square EVER against 25 cans in cold storage.
//   * Kegs left cold storage onto a tap line without a Draft Restock ring — the
//     ±1–2 keg drifts, the same mechanism as the 47 unbooked keg-to-draft moves.
//
// The one genuine dispute was a hand stock take in the Square Dashboard on
// 2026-08-11 (Epic Hazy −48, Blackberry Lemon Wheat +98, ninety seconds apart,
// same team member) that cold storage never recorded. That was put to a person,
// who ruled for cold storage. It is the shape to watch for: the taproom stocking
// Square by hand in parallel with cold storage. If that habit continues, this
// gate will keep overwriting it, and the argument for shutting the gate again is
// that someone is still counting into the wrong system.
//
// Turning this on makes cold storage overwrite Square. If it is ever shut again,
// re-open it the same way — adjudicate the disagreements first, then flip. The
// gate is the last thing to flip, not the first.
export const PUSH_TO_SQUARE_ENABLED = true;

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
