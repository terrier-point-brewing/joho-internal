// lib/reports/draftBookingGap.ts
//
// Did a keg go on this tap without anyone ringing Draft Restock?
//
// A keg only leaves cold storage — and only reaches the excise record — when the
// Draft Restock line item is rung in Square. Assigning a beer to a tap in Draft
// Stats books nothing: it decides where pours are ATTRIBUTED, not that inventory
// moved. The two look identical on the tap card, which is why the first keg on a
// newly assigned tap is the one that goes missing. Nothing on screen says the
// keg was never booked, and pours start landing correctly either way.
//
// Found by the 2026-08-31 physical count. Coffee Epic had poured 900 fl oz and
// Transfusion Pilsner 212 with ZERO restocks ever rung on either tap; across all
// beers roughly 1.6 bbl had poured that no keg was booked for.
//
// PURE. The caller supplies pour totals and tap config; this decides only whether
// to complain, and about what.

/** Full keg volumes are the threshold, so a partly-poured keg never trips this. */
export interface TapBookingInput {
  tapNumber: number;
  beerName: string | null;
  /** null when no Draft Restock has ever been rung for this tap. */
  lastRestockAt: string | null;
  /** Pours attributed to this tap's beer strictly AFTER the last restock date. */
  pouredSinceRestockFlOz: number;
  /** Every pour ever attributed to this tap's beer. Only used when never restocked. */
  pouredEverFlOz: number;
  /** Volume of the tap's configured swap keg. Null when the tap has none. */
  swapKegFlOz: number | null;
  /** How many of that swap keg are in cold storage right now. */
  swapKegsOnHand: number;
}

export type BookingGapKind = "never_booked" | "unbooked_kegs" | "no_keg_to_draw";

export interface BookingGap {
  tapNumber: number;
  beerName: string | null;
  kind: BookingGapKind;
  /** Whole kegs believed to have poured with no ring behind them. 0 for no_keg_to_draw. */
  unbookedKegs: number;
  detail: string;
}

const round = (n: number) => Math.round(n);

/**
 * PURE: one tap's booking problems, worst first.
 *
 * Thresholds are deliberately conservative — a tap must have poured a WHOLE swap
 * keg beyond its last ring before `unbooked_kegs` fires. Real kegs never pour
 * their full volume (foam, line loss, the heel), so this cannot fire on a keg
 * that was booked correctly. An alert that cries wolf is one the taproom learns
 * to dismiss, and this one has to survive being ignored for a month at a time.
 *
 * `never_booked` is the exception and has no volume threshold: a tap that has
 * poured ANY beer with no restock ever rung is unambiguous, whatever the amount.
 * That is the case the count actually found, and waiting for a full keg would
 * have hidden Transfusion Pilsner at 212 fl oz.
 */
export function tapBookingGaps(input: TapBookingInput): BookingGap[] {
  const out: BookingGap[] = [];
  const { tapNumber, beerName, swapKegFlOz } = input;

  if (input.lastRestockAt === null && input.pouredEverFlOz > 0) {
    out.push({
      tapNumber, beerName, kind: "never_booked",
      unbookedKegs: swapKegFlOz && swapKegFlOz > 0
        ? Math.max(1, Math.floor(input.pouredEverFlOz / swapKegFlOz))
        : 1,
      detail:
        `${round(input.pouredEverFlOz)} fl oz has poured on this tap and no Draft Restock has ever been rung. ` +
        `The keg is still on the books and carries no excise.`,
    });
  } else if (swapKegFlOz && swapKegFlOz > 0 && input.pouredSinceRestockFlOz > swapKegFlOz) {
    const kegs = Math.floor(input.pouredSinceRestockFlOz / swapKegFlOz);
    out.push({
      tapNumber, beerName, kind: "unbooked_kegs", unbookedKegs: kegs,
      detail:
        `${round(input.pouredSinceRestockFlOz)} fl oz has poured since the last Draft Restock — ` +
        `more than ${kegs === 1 ? "a full keg" : `${kegs} full kegs`}. ` +
        `${kegs === 1 ? "A keg went on" : `${kegs} kegs went on`} without a ring.`,
    });
  }

  // Forward-looking, and a different failure: the ring will not have anything to
  // draw. Reported even when the tap is otherwise clean, because the fix is to
  // stock or re-point the tap BEFORE the next keg change, not after.
  if (input.swapKegsOnHand <= 0) {
    out.push({
      tapNumber, beerName, kind: "no_keg_to_draw", unbookedKegs: 0,
      detail:
        `No ${swapKegFlOz ? "matching " : ""}swap keg is in cold storage, so the next Draft Restock ` +
        `has nothing to draw down and will not book.`,
    });
  }

  return out;
}

/** Every tap's gaps, flattened. Taps with no beer assigned are skipped by the caller. */
export function allTapBookingGaps(taps: TapBookingInput[]): BookingGap[] {
  return taps.flatMap(tapBookingGaps);
}
