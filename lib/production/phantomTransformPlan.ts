// lib/production/phantomTransformPlan.ts
//
// Planning math for resolving a phantom-export alert against cold-storage stock
// that is the WRONG SHAPE — a single can was rung, cold storage holds cases.
//
// reconcilePhantom accepts only a lot of the exact size that was booked, and
// that guard is not negotiable: excise and volume were booked per unit and are
// never recomputed. The route to a match is therefore to reshape the stock
// first — break the case into cans — and then reconcile through the unchanged
// path. This module works out whether such a break exists and what it costs.
//
// NOTHING HERE RUNS AUTOMATICALLY. A plan is a proposal an operator clicks; a
// transform destroys inventory (kegs lose real beer in either direction, and
// every transform is irreversible), so it is never something the app decides to
// do on someone's behalf while reconciling.
//
// The yield is the plain whole-unit ratio — 1 case of 24 x 16 oz gives 24 cans,
// 1 x 1/2 keg gives 3 x 1/6 — NOT previewTransform's maxToUnits. maxToUnits is
// the largest count the DB constraint would tolerate, and the constraint's
// rounding slack scales with the output count, so at 24 outputs it would permit
// 25 cans out of a 24-can case. That slack exists to forgive stored rounding on
// a hand-entered count, not to be maximised against. Planning takes the honest
// ratio and then checks it against previewTransform, so the plan we propose is
// one the database would also accept.

import { previewTransform } from "./coldStorageTransform";

/** Float dust when dividing stored whole-fl-oz volumes. */
const EPS = 1e-6;

export interface PhantomTransformPlan {
  /** cold_storage_inventory.id of the lot to spend — the RPC's p_lot_id. */
  lotId: string;
  fromVariationId: string;
  fromVariationName: string;
  fromVolumeFlOz: number;
  fromUnits: number;
  toVariationId: string;
  toVariationName: string;
  toVolumeFlOz: number;
  toUnits: number;
  batchId: string;
  batchCode: string;
  /** Beer lost by the break, in fl oz. Negative dust is reported as no loss. */
  shrinkageFlOz: number;
  /** True when the two sides tie to within stored rounding — no real loss. */
  lossless: boolean;
}

export interface PlanTransformInput {
  lotId: string;
  lotVariationId: string;
  lotVariationName: string;
  lotVolumeFlOz: number;
  onHand: number;
  batchId: string;
  batchCode: string;
  targetVariationId: string;
  targetVariationName: string;
  targetVolumeFlOz: number;
  /** Units of the target the alert needs covered. */
  unitsNeeded: number;
}

/**
 * The break that would put `unitsNeeded` of the target variation on hand, or
 * null when this lot cannot get there: it is the same variation, it is smaller
 * than the target (a can cannot become a case here — a build-up is an operator
 * decision about combining stock, not a consequence of one sale), or there
 * aren't enough parent units to cover the need.
 */
export function planTransform(input: PlanTransformInput): PhantomTransformPlan | null {
  const {
    lotId, lotVariationId, lotVariationName, lotVolumeFlOz, onHand,
    batchId, batchCode, targetVariationId, targetVariationName, targetVolumeFlOz,
    unitsNeeded,
  } = input;

  // The RPC rejects a transform that doesn't change variation, and a plan for
  // one would be nonsense anyway — a same-size lot is already eligible.
  if (!targetVariationId || targetVariationId === lotVariationId) return null;
  if (!(lotVolumeFlOz > 0) || !(targetVolumeFlOz > 0) || !(unitsNeeded > 0)) return null;

  const yieldPerParent = Math.floor(lotVolumeFlOz / targetVolumeFlOz + EPS);
  if (yieldPerParent < 1) return null;

  const fromUnits = Math.ceil(unitsNeeded / yieldPerParent);
  if (fromUnits > onHand) return null;
  const toUnits = fromUnits * yieldPerParent;

  const preview = previewTransform({
    fromUnits,
    fromVolumeFlOz: lotVolumeFlOz,
    toUnits,
    toVolumeFlOz: targetVolumeFlOz,
  });
  // Belt and braces: the ratio can't create volume, but the DB is the enforcer
  // and we never propose something it would reject.
  if (preview.createsVolume) return null;

  return {
    lotId,
    fromVariationId: lotVariationId,
    fromVariationName: lotVariationName,
    fromVolumeFlOz: lotVolumeFlOz,
    fromUnits,
    toVariationId: targetVariationId,
    toVariationName: targetVariationName,
    toVolumeFlOz: targetVolumeFlOz,
    toUnits,
    batchId,
    batchCode,
    shrinkageFlOz: preview.withinRoundingSlack ? 0 : preview.shrinkageFlOz,
    lossless: preview.withinRoundingSlack,
  };
}
