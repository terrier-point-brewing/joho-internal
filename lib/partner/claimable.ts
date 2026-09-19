/**
 * Beer a partner may claim.
 *
 * Batches are allocated to commitments first and the rest goes to the taproom,
 * so the taproom's unshipped share (plus any remainder nobody allocated) is the
 * pool. A slice of every batch is held back for the taproom first — the buffer,
 * a percentage of the BATCH, set in Settings — and what is left is claimable:
 *
 *   basis      = packaged volume once anything is packaged, else planned volume
 *   pool       = Σ taproom allocations' (share − already shipped) + unallocated
 *   claimable  = max(0, pool − buffer% × basis)
 *
 * and, once packaging has started, the basis becomes the batch's projected
 * yield and the pool is capped at what is physically left (projected yield −
 * everything shipped) after every other partner's unshipped share.
 *
 * The share/basis/unallocated arithmetic is the re-home engine's
 * (lib/production/rehome.ts listHomes) on purpose: approval draws the claim out
 * through the same numbers, so what a partner is shown and what a brewer can
 * approve cannot disagree by construction.
 */
import { bblToPct } from "@/lib/production/rehome";

const EPS = 1e-4;
const floor2 = (n: number) => Math.floor(n * 100 + 1e-6) / 100;
const round2 = (n: number) => Math.round(n * 100) / 100;

export const DEFAULT_TAPROOM_BUFFER_PCT = 10;

export interface ClaimAllocation {
  id: string;
  channel: string;
  percentage: number;
  written_off_at: string | null;
  exported_bbl: number;
}

export interface ClaimBatchInput {
  planned_bbl: number;
  produced_bbl: number;
  converted_bbl: number;
  /**
   * Packaged so far PLUS what is still in tank at the house packaging yield
   * (projectBatchYield). A batch that is half packaged is not a half-size
   * batch: measuring shares against packaged-to-date alone made every
   * part-packaged batch read as having nothing left to claim.
   */
  projected_bbl?: number;
  /**
   * Everything that has left the batch, whoever it was credited to — including
   * rows with no allocation. Once beer is packaged this bounds the pool by what
   * is physically still here: the taproom pouring kegs nobody booked against
   * its allocation must not leave a paper share a partner can claim.
   */
  total_exported_bbl?: number;
  allocations: ClaimAllocation[];
  bufferPct: number;
}

export interface ClaimSource {
  /** null = the batch's unallocated remainder. */
  allocationId: string | null;
  percentage: number;
  freeBbl: number;
}

export interface ClaimPool {
  basisBbl: number;
  bufferBbl: number;
  claimableBbl: number;
  /**
   * How much of `claimableBbl` is packaged and sitting here today, against how
   * much is still in tank and only expected. "4 bbl available" means something
   * very different when none of it has been packaged yet, so the two are never
   * shown as one number. They always sum to `claimableBbl`.
   */
  readyNowBbl: number;
  inTankBbl: number;
  /** Where a claim is drawn from, in draw order: unallocated first, then taproom. */
  sources: ClaimSource[];
}

export function claimPool(b: ClaimBatchInput): ClaimPool {
  // Nothing packaged: planned volume, the house convention for an allocation
  // percentage. Once packaging starts: the projected yield, which converges on
  // the packaged volume as the tank drains.
  const basisBbl = b.produced_bbl > EPS ? Math.max(b.produced_bbl, b.projected_bbl ?? 0) : b.planned_bbl;
  if (basisBbl <= EPS) return { basisBbl: 0, bufferBbl: 0, claimableBbl: 0, readyNowBbl: 0, inTankBbl: 0, sources: [] };

  const convertedPct = b.planned_bbl > EPS ? (b.converted_bbl / b.planned_bbl) * 100 : 0;
  const totalPct = b.allocations.reduce((s, a) => s + Number(a.percentage), 0) + convertedPct;
  const unallocatedPct = Math.max(0, 100 - totalPct);

  const sources: ClaimSource[] = [];
  if (unallocatedPct > EPS) {
    sources.push({ allocationId: null, percentage: round2(unallocatedPct), freeBbl: round2((unallocatedPct / 100) * basisBbl) });
  }
  const taproom = b.allocations
    .filter((a) => a.channel === "taproom" && !a.written_off_at)
    .map((a) => ({
      allocationId: a.id,
      percentage: Number(a.percentage),
      freeBbl: round2(Math.max(0, (Number(a.percentage) / 100) * basisBbl - a.exported_bbl)),
    }))
    .filter((s) => s.freeBbl > EPS)
    .sort((x, y) => y.freeBbl - x.freeBbl);
  sources.push(...taproom);

  let pool = sources.reduce((s, x) => s + x.freeBbl, 0);
  if (b.produced_bbl > EPS && b.total_exported_bbl != null) {
    // allocationReserve.batchReserve's on-hand reading (produced − shipped),
    // extended by the beer still expected out of the tank.
    const onHand = Math.max(0, basisBbl - b.total_exported_bbl);
    const owedToOthers = b.allocations
      .filter((a) => a.channel !== "taproom" && !a.written_off_at)
      .reduce((s, a) => s + Math.max(0, (Number(a.percentage) / 100) * basisBbl - a.exported_bbl), 0);
    pool = Math.min(pool, Math.max(0, onHand - owedToOthers));
  }
  const bufferBbl = round2((Math.min(100, Math.max(0, b.bufferPct)) / 100) * basisBbl);
  // Floored, never rounded up: the number shown is a promise the approval has
  // to be able to keep.
  const claimableBbl = floor2(Math.max(0, pool - bufferBbl));

  // Packaged beer physically here that no other partner is still owed out of
  // what has been packaged so far. A claim is served from that first; the rest
  // of it has to wait for the tank.
  const packagedOnHand = Math.max(0, b.produced_bbl - (b.total_exported_bbl ?? 0));
  const othersOwedOfPackaged = b.allocations
    .filter((a) => a.channel !== "taproom" && !a.written_off_at)
    .reduce((s, a) => s + Math.max(0, (Number(a.percentage) / 100) * b.produced_bbl - a.exported_bbl), 0);
  const readyNowBbl = floor2(Math.min(claimableBbl, Math.max(0, packagedOnHand - othersOwedOfPackaged)));
  return { basisBbl, bufferBbl, claimableBbl, readyNowBbl, inTankBbl: round2(claimableBbl - readyNowBbl), sources };
}

export interface ClaimDraw { allocationId: string | null; bbl: number; newPct: number | null }
export interface ClaimPlan { targetPct: number; draws: ClaimDraw[] }

/** Size a claim of `bbl` against the pool. Throws with a reason a brewer can act on. */
export function planClaim(pool: ClaimPool, bbl: number): ClaimPlan {
  if (!(bbl > EPS)) throw new Error("Nothing to claim.");
  if (bbl > pool.claimableBbl + EPS) {
    throw new Error(`Only ${pool.claimableBbl} bbl of this batch can be claimed right now (after the taproom's ${pool.bufferBbl} bbl reserve), not ${round2(bbl)}.`);
  }
  const targetPct = bblToPct(bbl, pool.basisBbl);
  if (targetPct <= 0) throw new Error("The claim rounds to zero percent of the batch.");

  const draws: ClaimDraw[] = [];
  let left = bbl;
  for (const s of pool.sources) {
    if (left <= EPS) break;
    const take = Math.min(left, s.freeBbl);
    left = round2(left - take);
    draws.push({
      allocationId: s.allocationId,
      bbl: round2(take),
      newPct: s.allocationId == null ? null : Math.max(0, round2(s.percentage - bblToPct(take, pool.basisBbl))),
    });
  }
  return { targetPct, draws };
}

/**
 * A partner flagged `recipes_exclusive` has beer that is never offered to
 * anyone else. Every recipe here belongs to SOME partner, so ownership alone
 * cannot be the rule — that would hide all claimable beer from everyone.
 */
export function visibleToPartner(viewerPartnerId: string, owner: { partner_id: string | null; exclusive: boolean }): boolean {
  if (!owner.partner_id || owner.partner_id === viewerPartnerId) return true;
  return !owner.exclusive;
}
