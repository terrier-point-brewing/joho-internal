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
// ── SHUT AGAIN 2026-08-31 ────────────────────────────────────────────────────
//
// The shape above is exactly what happened, at full scale. A physical count of
// the cold room was taken on 2026-08-31 and entered into the Square Dashboard,
// because the app has nowhere to record a count. The push read all 23 lines as
// drift and reversed every one of them — kegs at 17:38Z, cans at 22:31Z. Each
// row in square_inventory_reconciliations for that day carries the counted
// number in square_cans_before and the (wrong) book number in
// cold_storage_cans. The count now exists only on paper.
//
// The count also exposed a second reason not to push: the reconciler cannot see
// a can family whose LOOSE tier is at zero. Families are built from
// cold_storage_inventory rows, so a family holding only cases and 4-packs has no
// loose row, deriveCansEach throws, and the family is dropped into plan.skips —
// which pushInventoryToSquare discards without surfacing. On 2026-08-31 that hid
// 684 cans across eight families, and made Epic Hazy push 2 onto Square against
// 330 actually in cold storage. A skipped family and a family in perfect
// agreement are indistinguishable in the cron record.
//
// Re-open only after ALL THREE hold, in this order:
//   1. cold_storage_inventory is trued up to the 2026-08-31 count;
//   2. the loose-tier bug is fixed and skips are surfaced as warnings, so a
//      family that cannot be measured says so;
//   3. a push is run by hand and its planned writes read as corrections rather
//      than as the count being erased a second time.
//
// ── RE-OPENED 2026-09-01 ─────────────────────────────────────────────────────
//
// All three hold, and the direction of every correction has reversed. What made
// this safe, in the order it happened:
//
//   1. #521's migrations trued cold storage to the count. Every keg line and all
//      fourteen can families tie to the sheet exactly. Cold storage is no longer
//      the stale side of the argument — it is the counted side, so "cold storage
//      overwrites Square" now means the count overwrites the book numbers the
//      push itself wrote on 2026-08-31, rather than the reverse.
//   2. #521 fixed the loose-tier blind spot, and #522 fixed a double-count it
//      exposed. Reading the drift endpoint against prod between each deploy —
//      cheap, because the gate was shut and the read is observe-only — is what
//      made this work: it showed the bug (five of fourteen can families
//      measured, warnings empty), then the fix (all fourteen), and then Epic
//      Hazy at 516 against 258 on hand, because two label families sharing one
//      Square SKU were summing the same stock twice. That last one no test had
//      caught, and an open gate would have written it to Square.
//   3. The final read-back was reviewed line by line before this flip: fourteen
//      can families and fifty-eight keg SKUs, zero warnings, zero dead links,
//      nothing unmeasured. Every planned write moves Square TOWARD the physical
//      count — Epic Hazy 2 -> 258, Blackberry Lemon Wheat 2 -> 77, Castle Ruins
//      6 -> 33, Oktoberfest 159 -> 62, Carolina Pale Ale's eight phantom half
//      kegs 8 -> 0, Vienna 14 -> 8 halves and 14 -> 20 sixtels.
//
// The lesson worth keeping: the read-back is not a formality. Two of the three
// bugs fixed in this sequence were found by reading prod through the drift
// endpoint with the gate shut, not by tests. Do that before every re-open.
//
// The watch-for shape is unchanged and now has a name: someone counting into the
// Square Dashboard in parallel with cold storage. The reason it is safe to leave
// the gate open is that cold storage is currently right, not that the habit has
// stopped. Until a count screen exists in the app (the real fix), a physical
// count still has nowhere to go but Square, where this will erase it. Shut the
// gate BEFORE the next count, not after.
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
