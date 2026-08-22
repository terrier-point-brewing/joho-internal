// lib/production/fungibleGroupRules.ts
//
// What may and may not share one Square button.
//
// Declaring a SKU fungible says "a sale here can be filled from any of these
// packagings". That is only true when the packagings are interchangeable to the
// person buying and to the ledger behind them, so three things have to hold.
// They are checked when the group is declared and when a member joins, because
// a group that fails any of them does not undercharge or over-deplete loudly —
// it does so quietly, one sale at a time.

/** One candidate member, as the rules need to see it. */
export interface FungibleCandidate {
  variationId: string;
  variationName: string;
  /** 'keg' | 'can' — the link's own packaging column. */
  packaging: string;
  /** packaging_variations.partner_id — null for house stock. */
  partnerId: string | null;
  /** packaging_variations.total_volume_fl_oz — beer per sold unit. */
  totalVolumeFlOz: number | null;
}

export type FungibleCheck = { ok: true } | { ok: false; reason: string };

/**
 * Pure. Exported for unit testing.
 *
 * 1. SAME VOLUME. Square sells "one". If one member is a 4-pack and another a
 *    case, a single sale means 64 fl oz or 384 depending on which lot happened
 *    to be oldest — and the excise on it moves with it. Nothing downstream can
 *    recover the difference, so it is refused here.
 *
 * 2. SAME OWNER. The house-stock preference in selectSaleLink exists because a
 *    partner's branded keg leaves on a contract shipment, never over the bar.
 *    Letting a group mix house and partner packaging would route around that
 *    guard and quietly sell someone else's inventory. Two packagings of the SAME
 *    partner's beer — a printed can and a labeled blank of theirs — are fine,
 *    which is the case this feature was built for.
 *
 * 3. SAME CONTAINER CLASS. A keg and a can behind one button is the volume
 *    problem again, in its most obvious form.
 */
export function checkFungibleGroup(members: FungibleCandidate[]): FungibleCheck {
  if (members.length < 2) return { ok: true };

  const packagings = new Set(members.map((m) => m.packaging));
  if (packagings.size > 1) {
    return { ok: false, reason: "A shared Square item must be all kegs or all cans, not a mix." };
  }

  const owners = new Set(members.map((m) => m.partnerId ?? "house"));
  if (owners.size > 1) {
    const named = members.map((m) => `${m.variationName} (${m.partnerId ? "partner" : "house"})`).join(", ");
    return {
      ok: false,
      reason:
        "A shared Square item must be all house packaging or all the same partner's — " +
        `a taproom sale must never be able to draw down a partner's stock. Got: ${named}.`,
    };
  }

  const volumes = new Set(members.map((m) => (m.totalVolumeFlOz == null ? "unknown" : String(m.totalVolumeFlOz))));
  if (volumes.has("unknown")) {
    return { ok: false, reason: "Every packaging behind a shared Square item needs a coded volume." };
  }
  if (volumes.size > 1) {
    const named = members.map((m) => `${m.variationName} (${m.totalVolumeFlOz} fl oz)`).join(", ");
    return {
      ok: false,
      reason: `Every packaging behind a shared Square item must hold the same volume — one sale is one amount of beer. Got: ${named}.`,
    };
  }

  return { ok: true };
}
