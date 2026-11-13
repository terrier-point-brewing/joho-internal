import { computeTankVolumes, hasLedgerActivity, type LedgerTransfer } from "./volumeLedger";

/**
 * In-place conversion: the beer becomes another beer without leaving its tank
 * (cherry and cacao dosed straight into the brite the Oatmeal Stout is sitting
 * in). The tank can only hold one batch, so an in-place conversion is always
 * the WHOLE tank — there is no such thing as converting part of a vessel's
 * contents where they sit.
 *
 * That is why the volume is derived here rather than typed: a hand-typed figure
 * leaves ledger dust behind (B-069 kept 0.008 bbl of Oatmeal Stout in tank 33
 * after its 31.66 bbl conversion, which then blocked the tank), and dust in a
 * single-occupancy tank is a batch that can never be cleared.
 */

/** What an in-place conversion row looks like on the ledger. */
export function isInPlaceConversion(t: {
  transfer_type?: string | null; from_tank_id: string | null; to_tank_id: string | null;
}): boolean {
  return t.transfer_type === "conversion" && !!t.from_tank_id && t.from_tank_id === t.to_tank_id;
}

export type InPlaceConversionVolume =
  | { ok: true; inTankBbl: number; deliveredBbl: number }
  | { ok: false; error: string };

/**
 * Everything the source batch holds in `tankId`, less the shrinkage the
 * operator declared, is what the new batch receives.
 */
export function resolveInPlaceConversionVolume({
  batchId, batchVolumeBbl, tankId, shrinkageBbl, ledger,
}: {
  batchId: string;
  batchVolumeBbl: number;
  tankId: string;
  shrinkageBbl: number;
  ledger: LedgerTransfer[];
}): InPlaceConversionVolume {
  // A batch the ledger has never heard of sits in its assigned tank at its
  // headline volume — the same fallback the floorplan uses.
  const inTankBbl = hasLedgerActivity(batchId, ledger)
    ? (computeTankVolumes(batchId, batchVolumeBbl, ledger)[tankId] ?? 0)
    : batchVolumeBbl;
  if (!(inTankBbl > 0)) {
    return { ok: false, error: "This batch has no beer in that tank to convert." };
  }
  const shrinkage = Math.max(0, Number(shrinkageBbl) || 0);
  const deliveredBbl = inTankBbl - shrinkage;
  if (!(deliveredBbl > 0)) {
    return { ok: false, error: "Shrinkage cannot be the whole tank — nothing would be left to convert." };
  }
  return { ok: true, inTankBbl, deliveredBbl };
}
