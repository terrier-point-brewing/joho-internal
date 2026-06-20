import { BatchTransfer, Equipment, BrewBatch } from "../types";

/** Initial packaged quantity recorded on a kegging/canning transfer. */
export function transferInitialQty(t: BatchTransfer): { qty: number; unit: "keg" | "can" } {
  if (t.transfer_type === "kegging") {
    return { qty: t.kegging_detail?.quantity ?? 0, unit: "keg" };
  }
  const cd = t.canning_detail;
  const cansPerUnit = cd ? (cd.format === "case" ? cd.cans_per_case : cd.format === "pack" ? cd.cans_per_pack : 1) : 0;
  return { qty: cd ? cd.quantity * cansPerUnit : 0, unit: "can" };
}

export interface ColdStorageLot {
  transfer: BatchTransfer;
  batch: BrewBatch | undefined;
  packaging: "keg" | "can";
  initialQty: number;
}

/**
 * Packaged lots currently held in cold storage: kegging/canning transfers whose
 * destination tank is a cold_storage unit. NOTE initialQty is the recorded packaged
 * count; net on-hand additionally requires summing brew_inventory_adjustments per lot.
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
