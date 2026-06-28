import { BatchTransfer } from "../types";

/**
 * Compute the volume currently held in each tank for a single batch.
 *
 * Algorithm:
 *  1. Sort transfers chronologically.
 *  2. Seed the first `from_tank_id` with `originalVol` — handles batches that existed
 *     before ledger tracking (assignment with no corresponding transfer record).
 *  3. Apply each transfer as a ±delta.
 *  4. Drop entries ≤ 0.001 BBL (floating-point dust).
 *
 * Returns {} when the batch has no transfers yet; caller falls back to
 * assignment-based volume.
 */
export function computeTankVolumes(
  batchId:     string,
  originalVol: number,
  allTransfers: BatchTransfer[],
): Record<string, number> {
  const transfers = allTransfers
    .filter((t) => t.batch_id === batchId)
    .sort((a, b) => new Date(a.transferred_at).getTime() - new Date(b.transferred_at).getTime());

  if (transfers.length === 0) return {};

  const vols: Record<string, number> = {};

  // Backward-compat seed: the first from_tank held the full original volume
  // before any ledger transfers existed. Only seed when nothing in the ledger
  // already explains how that tank got its volume (e.g. a prior Backlog→tank
  // transfer) — otherwise, on a fully-tracked batch, this double-counts when
  // same-day transfers tie-break in an order other than chronological intent.
  const firstFrom = transfers[0].from_tank_id;
  const firstFromHasArrival = transfers.some((t) => t.to_tank_id === firstFrom);
  if (firstFrom && !firstFromHasArrival) vols[firstFrom] = originalVol;

  for (const t of transfers) {
    const vol    = Number(t.volume_bbl    ?? 0);
    const shrink = Number(t.shrinkage_bbl ?? 0);
    if (t.from_tank_id) vols[t.from_tank_id] = (vols[t.from_tank_id] ?? 0) - vol - shrink;
    // Conversion transfers: volume goes to a DIFFERENT batch's tank — do not
    // credit the destination to this batch's ledger.
    if (t.to_tank_id && !t.to_batch_id) vols[t.to_tank_id] = (vols[t.to_tank_id] ?? 0) + vol;
  }

  return Object.fromEntries(Object.entries(vols).filter(([, v]) => v > 0.001));
}

export interface LocationBreakdown {
  backlog:     number;
  brewhouse:   number;
  fermenter:   number;
  brite:       number;
  packaging:   number;   // kegging + canning stations
  coldStorage: number;
  exported:    number;
  converted:   number;   // volume moved to a different batch via conversion
  shrinkage:   number;
}

/**
 * Break a batch's original volume down into named brewery locations.
 *
 * @param tankTypeById  Maps equipment ID → equipment type (e.g. "fermenter").
 *                      Can be derived from the equipment query or from the
 *                      from_tank / to_tank objects embedded in transfer records.
 * @param isAssigned    True when the batch has at least one active tank assignment
 *                      (used to decide whether pre-transfer volume is in backlog).
 */
export function computeLocationBreakdown(
  batchId:      string,
  originalVol:  number,
  allTransfers: BatchTransfer[],
  tankTypeById: Record<string, string>,
  isAssigned:   boolean,
): LocationBreakdown {
  const batchTransfers = allTransfers.filter((t) => t.batch_id === batchId);
  const tankVols       = computeTankVolumes(batchId, originalVol, allTransfers);

  // Totals that come purely from transfer records
  let shrinkage = 0;
  let exported  = 0;
  let converted = 0;
  for (const t of batchTransfers) {
    shrinkage += Number(t.shrinkage_bbl ?? 0);
    if (t.to_batch_id) {
      // Volume moved to a sibling batch via conversion — no longer this batch's
      converted += Number(t.volume_bbl ?? 0);
    } else {
      const destType = resolveType(t.to_tank_id, t.to_tank?.type, tankTypeById);
      if (destType === "export_bay" || destType === "loading_bay") {
        exported += Number(t.volume_bbl ?? 0);
      }
    }
  }

  const result: LocationBreakdown = {
    backlog: 0, brewhouse: 0, fermenter: 0, brite: 0,
    packaging: 0, coldStorage: 0, exported, converted, shrinkage,
  };

  if (batchTransfers.length === 0) {
    // No transfers yet — either in backlog (unassigned) or in the assigned tank.
    // The caller knows which tank from the assignment; we just report the total.
    result.backlog = isAssigned ? 0 : originalVol;
    return result;
  }

  // Classify each tank's net volume
  for (const [tankId, vol] of Object.entries(tankVols)) {
    const type = resolveType(tankId, undefined, tankTypeById)
      || resolveFromTransfers(tankId, batchTransfers);
    switch (type) {
      case "brewhouse":    result.brewhouse   += vol; break;
      case "fermenter":    result.fermenter   += vol; break;
      case "brite":        result.brite       += vol; break;
      case "kegging":
      case "canning":      result.packaging   += vol; break;
      case "cold_storage": result.coldStorage += vol; break;
      case "export_bay":
      case "loading_bay":  /* already counted in exported */ break;
      default:             break;
    }
  }

  // Export transfers written with from_tank_id=null (the norm, since
  // cold_storage_inventory is the authority for qty) never debit the
  // cold_storage tank in computeTankVolumes. Back-debit here so the
  // ledger stays balanced and available zeroes out after a full export.
  const nullSourceExportBbl = batchTransfers
    .filter((t) => t.transfer_type === "export" && !t.from_tank_id)
    .reduce((s, t) => s + Number(t.volume_bbl ?? 0), 0);
  result.coldStorage = Math.max(0, result.coldStorage - nullSourceExportBbl);

  return result;
}

function resolveType(
  tankId:      string | null | undefined,
  embeddedType: string | undefined,
  tankTypeById: Record<string, string>,
): string {
  if (embeddedType) return embeddedType;
  if (tankId)       return tankTypeById[tankId] ?? "";
  return "";
}

function resolveFromTransfers(tankId: string, transfers: BatchTransfer[]): string {
  for (const t of transfers) {
    if (t.from_tank_id === tankId && t.from_tank?.type) return t.from_tank.type;
    if (t.to_tank_id   === tankId && t.to_tank?.type)   return t.to_tank.type;
  }
  return "";
}
