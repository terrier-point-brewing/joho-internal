/**
 * Minimal shape of a `batch_transfers` row needed for volume math. The full
 * `BatchTransfer` type (app/production/types) is a structural superset, so
 * callers pass it directly — this keeps the ledger logic decoupled from the app.
 */
export interface LedgerTransfer {
  batch_id:      string;
  from_tank_id:  string | null;
  to_tank_id:    string | null;
  to_batch_id:   string | null;
  volume_bbl:    number;
  shrinkage_bbl: number;
  transferred_at: string;
  from_tank?: { type?: string | null } | null;
  to_tank?:   { type?: string | null } | null;
}

/**
 * Whether the ledger says anything at all about this batch — its own transfers,
 * or a sibling's conversion row handing it volume.
 *
 * Distinct from `computeTankVolumes(...)` returning `{}`, which conflates two
 * very different situations: a batch nobody has recorded a movement for, and a
 * batch whose every tank has been drained to zero. Callers that fall back to the
 * batch's headline volume when the ledger is silent MUST gate that fallback on
 * this, or they will paint a batch's full volume onto a tank the ledger knows is
 * empty (see BrewStatusTab's tank tiles).
 */
export function hasLedgerActivity(batchId: string, allTransfers: LedgerTransfer[]): boolean {
  return allTransfers.some((t) => t.batch_id === batchId || t.to_batch_id === batchId);
}

/**
 * Compute the volume currently held in each tank for a single batch.
 *
 * Algorithm:
 *  1. Gather this batch's OWN transfers (batch_id === batchId) and any
 *     conversion INFLOWS (to_batch_id === batchId — a sibling batch's row that
 *     handed volume to this batch's tank).
 *  2. Seed the first `from_tank_id` with `originalVol` — handles batches that
 *     existed before ledger tracking (assignment with no transfer record). This
 *     seed is skipped for conversion-born batches, whose starting volume is the
 *     inbound conversion arrival (seeding would double-count).
 *  3. Credit each conversion inflow to its destination tank.
 *  4. Apply each own transfer as a ±delta.
 *  5. Drop entries ≤ 0.001 BBL (floating-point dust).
 *
 * Returns {} when the batch has neither own transfers nor conversion inflows;
 * caller falls back to assignment-based volume.
 */
export function computeTankVolumes(
  batchId:     string,
  originalVol: number,
  allTransfers: LedgerTransfer[],
): Record<string, number> {
  const byTime = (a: LedgerTransfer, b: LedgerTransfer) =>
    new Date(a.transferred_at).getTime() - new Date(b.transferred_at).getTime();

  const own = allTransfers.filter((t) => t.batch_id === batchId).sort(byTime);
  // Conversion inflows: recorded on the SOURCE batch's ledger, destined for this
  // batch's tank. These are how a conversion-born batch receives its volume.
  const inbound = allTransfers
    .filter((t) => t.to_batch_id === batchId && t.batch_id !== batchId)
    .sort(byTime);

  if (own.length === 0 && inbound.length === 0) return {};

  const vols: Record<string, number> = {};

  // Backward-compat seed: the first from_tank held the full original volume
  // before any ledger transfers existed. Only seed when nothing in the ledger
  // already explains how that tank got its volume (e.g. a prior Backlog→tank
  // transfer) — otherwise, on a fully-tracked batch, this double-counts when
  // same-day transfers tie-break in an order other than chronological intent.
  //
  // Skip entirely for conversion-born batches: their origin IS the inbound
  // conversion arrival below, so seeding a phantom tank would double-count.
  if (inbound.length === 0 && own.length > 0) {
    const firstFrom = own[0].from_tank_id;
    const firstFromHasArrival = own.some((t) => t.to_tank_id === firstFrom);
    if (firstFrom && !firstFromHasArrival) vols[firstFrom] = originalVol;
  }

  // Credit conversion inflows into this batch's destination tank. Shrinkage on
  // these rows is the SOURCE batch's loss, not ours — only the delivered
  // volume_bbl lands here.
  for (const t of inbound) {
    if (t.to_tank_id) vols[t.to_tank_id] = (vols[t.to_tank_id] ?? 0) + Number(t.volume_bbl ?? 0);
  }

  for (const t of own) {
    const vol    = Number(t.volume_bbl    ?? 0);
    const shrink = Number(t.shrinkage_bbl ?? 0);
    if (t.from_tank_id) vols[t.from_tank_id] = (vols[t.from_tank_id] ?? 0) - vol - shrink;
    // Own conversion transfers: volume goes to a DIFFERENT batch's tank — do not
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
  allTransfers: LedgerTransfer[],
  tankTypeById: Record<string, string>,
  isAssigned:   boolean,
): LocationBreakdown {
  const batchTransfers = allTransfers.filter((t) => t.batch_id === batchId);
  // A conversion-born batch has no own transfers but still holds volume that
  // arrived via a sibling's conversion row.
  const inboundConversions = allTransfers.filter(
    (t) => t.to_batch_id === batchId && t.batch_id !== batchId,
  );
  const tankVols = computeTankVolumes(batchId, originalVol, allTransfers);

  // Totals that come purely from this batch's own transfer records.
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

  if (batchTransfers.length === 0 && inboundConversions.length === 0) {
    // No ledger activity at all — either in backlog (unassigned) or in the
    // assigned tank. The caller knows which tank from the assignment; we just
    // report the total.
    result.backlog = isAssigned ? 0 : originalVol;
    return result;
  }

  // Classify each tank's net volume (includes conversion inflows)
  for (const [tankId, vol] of Object.entries(tankVols)) {
    const type = resolveType(tankId, undefined, tankTypeById)
      || resolveFromTransfers(tankId, allTransfers);
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

  return result;
}

function resolveType(
  tankId:      string | null | undefined,
  embeddedType: string | null | undefined,
  tankTypeById: Record<string, string>,
): string {
  if (embeddedType) return embeddedType;
  if (tankId)       return tankTypeById[tankId] ?? "";
  return "";
}

function resolveFromTransfers(tankId: string, transfers: LedgerTransfer[]): string {
  for (const t of transfers) {
    if (t.from_tank_id === tankId && t.from_tank?.type) return t.from_tank.type;
    if (t.to_tank_id   === tankId && t.to_tank?.type)   return t.to_tank.type;
  }
  return "";
}
