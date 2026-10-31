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
  /**
   * Overdraft measured at the tap's most recent ring: pour fl oz recorded beyond
   * a full keg between the previous ring and that one. Null when unknown (no ring
   * yet, or a ring from before the overdraft was persisted).
   */
  lastRingOverdraftFlOz?: number | null;
  /** When that ring happened, for the message. */
  lastRingAt?: string | null;
}

export type BookingGapKind =
  | "never_booked"
  | "unbooked_kegs"
  | "restock_due"
  | "missed_restock"
  | "no_keg_to_draw";

/**
 * Fraction of a nominal keg poured before "ring it when you swap it" is worth
 * saying. A sixtel yields ~80% of its 661 fl oz on the median swap (the rest is
 * foam, line loss, the heel), so 75% means the keg on the tap is about to blow,
 * and a swap without a ring from here is what wipes the Square count.
 */
export const RESTOCK_DUE_FRACTION = 0.75;

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
  } else if (
    swapKegFlOz && swapKegFlOz > 0 &&
    input.pouredSinceRestockFlOz >= swapKegFlOz * RESTOCK_DUE_FRACTION
  ) {
    // Early, before the damage: the next swap on this tap MUST be rung. Once a
    // full keg has poured past the ring, the following ring nets the surplus
    // out of the recount and Square's draft count is reset to zero.
    out.push({
      tapNumber, beerName, kind: "restock_due", unbookedKegs: 0,
      detail:
        `${round(input.pouredSinceRestockFlOz)} of ${round(swapKegFlOz)} fl oz has poured since the last ` +
        `Draft Restock, so this keg is close to blowing. Ring Draft Restock when it is swapped — ` +
        `a swap without a ring here resets Square's draft count to zero.`,
    });
  }

  // After the damage: the most recent ring came more than a whole keg late, so
  // at least one keg poured with no ring and the recount floored to zero.
  // Square's draft count for this beer is wrong until someone sets it by hand.
  const overdraft = input.lastRingOverdraftFlOz ?? 0;
  if (swapKegFlOz && swapKegFlOz > 0 && overdraft >= swapKegFlOz) {
    const missed = Math.floor(overdraft / swapKegFlOz);
    const when = input.lastRingAt ? ` on ${input.lastRingAt.slice(0, 10)}` : "";
    out.push({
      tapNumber, beerName, kind: "missed_restock", unbookedKegs: missed,
      detail:
        `The Draft Restock rung${when} came ${round(overdraft)} fl oz past a full keg — ` +
        `${missed === 1 ? "a keg" : `${missed} kegs`} went on before it with no ring. ` +
        `Square's draft count was reset to 0 instead of a full keg: set it by hand to ` +
        `${round(swapKegFlOz)} fl oz less what has poured since that ring.`,
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
