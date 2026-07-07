import { BatchTransfer, Equipment, BrewBatch } from "../types";

/** Initial packaged quantity recorded on a kegging/canning transfer. */
export function transferInitialQty(t: BatchTransfer): { qty: number; unit: "keg" | "can" } {
  const unit = t.transfer_type === "kegging" ? "keg" : "can";
  return { qty: t.quantity ?? 0, unit };
}

export interface ColdStorageLot {
  transfer: BatchTransfer;
  batch: BrewBatch | undefined;
  packaging: "keg" | "can";
  initialQty: number;
}

/**
 * Packaged lots currently held in cold storage: kegging/canning transfers whose
 * destination tank is a cold_storage unit. initialQty is the recorded packaged count,
 * which is the current on-hand quantity for the lot.
 */
export function coldStorageLots(
  transfers: BatchTransfer[],
  tanks: Equipment[],
  batches: BrewBatch[],
): ColdStorageLot[] {
  const coldStorageTankIds = new Set(tanks.filter((t) => t.type === "cold_storage").map((t) => t.id));
  const batchById = new Map(batches.map((b) => [b.id, b]));
  return transfers
    .filter(
      (t) =>
        t.to_tank_id &&
        coldStorageTankIds.has(t.to_tank_id) &&
        (t.transfer_type === "kegging" || t.transfer_type === "canning"),
    )
    .map((t) => {
      const { qty, unit } = transferInitialQty(t);
      return { transfer: t, batch: batchById.get(t.batch_id), packaging: unit, initialQty: qty };
    });
}
