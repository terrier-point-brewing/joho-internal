// Pure allocation / reserve model for Export Bay shipping.
//
// Contract-brewing allocations are deposit-backed HARD guarantees: the partner
// pre-paid for `percentage × planned batch volume` (their "booked" bbl). Because
// shrinkage lowers the final yield and kegging/canning happens incrementally,
// the definite amount owed is `percentage × actual produced`, and the produced
// beer must be reserved so an early soft (wholesale/distribution) shipment can't
// strand a deposit holder. Wholesale/distribution allocations are SOFT — no
// deposit, billed at product price for whatever ships — so they carry no cap.
//
// See docs/superpowers/plans/2026-07-04-allocation-reserve-and-shipping-warnings.md.
// Decisions of record: produced = sum(volume_bbl) net fill (no shrinkage
// subtraction); coverage is evaluated per-batch against the FIFO draw.

export type AllocationChannel = "contract_brewing" | "distribution" | "wholesale" | "safety_stock";

const EPS = 1e-4;

/** Only contract-brewing allocations are deposit-backed (hard guarantees). */
export function isDepositBacked(channel: AllocationChannel): boolean {
  return channel === "contract_brewing";
}

export interface AllocationInput {
  id: string;
  batchId: string;
  channel: AllocationChannel;
  percentage: number;         // 0–100, locked at deposit time
  bookedBbl: number | null;   // commitments.volume_bbl; null for soft channels
  exportedBbl: number;        // volume already credited to this allocation
  writtenOff?: boolean;       // remaining owed volume forgiven → treated as fulfilled, reserve released
}

export interface BatchInput {
  batchId: string;
  producedBbl: number;        // sum(volume_bbl) of kegging/canning — net fill, NOT minus shrinkage
  totalExportedBbl: number;   // all export_transactions for the batch (allocated + over-delivery + ad-hoc)
  status: string;             // brew_batches.status; 'complete' finalizes the entitlement
  allocations: AllocationInput[];
}

// ── Per-allocation view ──────────────────────────────────────────────────────

export interface AllocationView {
  bookedBbl: number | null;           // B — pre-paid (contract only)
  realizableBbl: number;              // S — percentage × produced-so-far
  finalEntitlementBbl: number | null; // A — percentage × final produced (null until complete)
  exportedBbl: number;                // E
  depositBacked: boolean;
  writtenOff: boolean;                // remaining owed volume forgiven
  fulfilled: boolean;
}

export function allocationView(alloc: AllocationInput, batch: BatchInput): AllocationView {
  const depositBacked = isDepositBacked(alloc.channel);
  const realizableBbl = (alloc.percentage / 100) * batch.producedBbl;
  const complete = batch.status === "complete";
  const finalEntitlementBbl = complete ? realizableBbl : null;
  const writtenOff = !!alloc.writtenOff;
  // A written-off allocation is closed out (its remaining owed volume was
  // forgiven), so it counts as fulfilled regardless of how much shipped.
  // Otherwise: contract fulfillment is only meaningful once the batch is
  // complete (A is final); soft channels have no deposit, so "fulfilled" is
  // advisory — shipped at least the produced-so-far share.
  const fulfilled = writtenOff
    ? true
    : depositBacked
      ? complete && finalEntitlementBbl != null && alloc.exportedBbl >= finalEntitlementBbl - EPS
      : alloc.exportedBbl >= realizableBbl - EPS;
  return {
    bookedBbl: alloc.bookedBbl,
    realizableBbl,
    finalEntitlementBbl,
    exportedBbl: alloc.exportedBbl,
    depositBacked,
    writtenOff,
    fulfilled,
  };
}

// ── Per-batch reserve ────────────────────────────────────────────────────────

export interface BatchReserve {
  batchId: string;
  producedBbl: number;
  onHandBbl: number;               // produced − everything already shipped from the batch
  reservedForContractBbl: number;  // still owed to deposit holders from this batch
  freeToShipBbl: number;           // unclaimed surplus = onHand − reserved
  underCovered: boolean;           // produced hasn't reached the guaranteed total yet
}

export function batchReserve(batch: BatchInput): BatchReserve {
  // Written-off contract allocations are closed — they no longer reserve beer,
  // nor do they count toward the guaranteed total that drives under-coverage.
  const contract = batch.allocations.filter((a) => isDepositBacked(a.channel) && !a.writtenOff);
  const reservedForContractBbl = contract.reduce((s, a) => {
    const realizable = (a.percentage / 100) * batch.producedBbl;
    return s + Math.max(0, realizable - a.exportedBbl);
  }, 0);
  const onHandBbl = Math.max(0, batch.producedBbl - batch.totalExportedBbl);
  const freeToShipBbl = Math.max(0, onHandBbl - reservedForContractBbl);
  // Under-coverage means the batch can no longer physically cover what its
  // deposit holders are still owed: on-hand has fallen below the reserve.
  // It is NOT "produced < booked" — booked is a pre-shrinkage estimate and the
  // partner bears their pro-rata share of shrinkage, so every complete batch
  // with any shrinkage would trip that test even when fully delivered.
  // Only meaningful once COMPLETE: before that, produced is still climbing.
  const underCovered = batch.status === "complete" && onHandBbl < reservedForContractBbl - EPS;
  return { batchId: batch.batchId, producedBbl: batch.producedBbl, onHandBbl, reservedForContractBbl, freeToShipBbl, underCovered };
}

// ── Completion reconciliation (contract only) ────────────────────────────────

export interface CompletionReconciliation {
  finalEntitlementBbl: number; // A = percentage × final produced
  overDeliveredBbl: number;    // max(0, E − A) — beer shipped beyond the final entitlement (bill or absorb)
  underDeliveredBbl: number;   // max(0, A − E) — beer still owed (make good in beer, or manual refund)
}

/**
 * At batch completion, reconcile a contract allocation's final actual entitlement
 * (A = percentage × final produced) against what shipped (E). Returns null for
 * soft channels (no deposit) or before the batch is complete (A is not final).
 *
 * NOTE — shrinkage does NOT create a refund. The deposit buys a PERCENTAGE of the
 * batch, and the partner bears their pro-rata share of shrinkage: delivering A
 * (their % of actual produced) fully satisfies the deposit even though A < the
 * booked estimate B. Refunds come only from a reduction in the partner's
 * percentage (the manual allocations/[id]/adjust flow), not from yield. So we
 * surface only the two actionable gaps: over-delivery (E − A) and under-delivery
 * (A − E). Both are advisory; nothing is issued here.
 */
export function completionReconciliation(alloc: AllocationInput, batch: BatchInput): CompletionReconciliation | null {
  if (!isDepositBacked(alloc.channel)) return null;
  if (batch.status !== "complete") return null;
  const a = (alloc.percentage / 100) * batch.producedBbl;
  const e = alloc.exportedBbl;
  return {
    finalEntitlementBbl: round4(a),
    overDeliveredBbl: round4(Math.max(0, e - a)),
    underDeliveredBbl: round4(Math.max(0, a - e)),
  };
}

// ── Shipment planning (crediting + warnings) ─────────────────────────────────

export type ShipmentWarning =
  // Draw on a batch would leave less than what other deposit holders are still owed.
  | { type: "guarantee_coverage"; batchId: string; reservedBbl: number; onHandAfterBbl: number; drawBbl: number }
  // A complete batch no longer holds enough beer to settle what its deposit
  // holders are still owed — beer went somewhere else.
  | { type: "reserve_shortfall"; batchId: string; onHandBbl: number; owedBbl: number }
  // Shipped beyond every bookable claim (contract booked, with no soft allocation to absorb).
  | { type: "over_booked"; overBbl: number };

export interface ShipmentCandidate {
  allocationId: string;
  batchId: string;
  channel: AllocationChannel;
  bookedRemainingBbl: number | null; // contract: max(0, booked − exported); soft: null (uncapped)
  // contract: max(0, percentage × produced − exported) — the entitlement the
  // batch has ACTUALLY made. `booked` is a pre-shrinkage estimate, so a fully
  // delivered batch keeps a booked remainder equal to its shrinkage; crediting
  // against that lets one batch absorb another batch's beer. Undefined on
  // legacy callers → this term does not cap. Soft channels: null (uncapped).
  realizableRemainingBbl?: number | null;
}

export interface ShipmentPlanInput {
  requestedBbl: number;
  candidates: ShipmentCandidate[];              // priority order: contract first, then soft, oldest batch first
  perBatchDrawBbl: { batchId: string; drawBbl: number }[]; // what the cold-storage FIFO actually draws
  batches: BatchInput[];                         // reserve state for every batch of the recipe
}

export interface ShipmentCredit {
  allocationId: string | null; // null → over-delivery bucket
  bbl: number;
  overAllocation: boolean;
}

export interface ShipmentPlan {
  credits: ShipmentCredit[];
  warnings: ShipmentWarning[];
}

/**
 * Plans how a shipment is credited across a partner's allocations and which
 * advisory warnings it raises. Contract allocations are credited up to their
 * booked remaining; soft allocations are uncapped; anything beyond all bookable
 * claims becomes an explicit over-delivery record (never inflates an allocation
 * past its booked amount). Pure — no I/O; the caller supplies produced/exported
 * figures and the simulated FIFO draw.
 */
export function planShipment(input: ShipmentPlanInput): ShipmentPlan {
  const credits: ShipmentCredit[] = [];
  const warnings: ShipmentWarning[] = [];

  // ── Crediting ──────────────────────────────────────────────────────────────
  let bblLeft = input.requestedBbl;
  for (const c of input.candidates) {
    if (bblLeft <= EPS) break;
    // A contract credit can never exceed either the pre-paid booking or the
    // share the batch actually produced — whichever is smaller.
    const realizableCap = c.realizableRemainingBbl == null ? Infinity : Math.max(0, c.realizableRemainingBbl);
    const cap = isDepositBacked(c.channel)
      ? Math.min(Math.max(0, c.bookedRemainingBbl ?? 0), realizableCap)
      : Infinity;
    const take = Math.min(cap, bblLeft);
    if (take > EPS) {
      credits.push({ allocationId: c.allocationId, bbl: round4(take), overAllocation: false });
      bblLeft -= take;
    }
  }
  if (bblLeft > EPS) {
    credits.push({ allocationId: null, bbl: round4(bblLeft), overAllocation: true });
    warnings.push({ type: "over_booked", overBbl: round4(bblLeft) });
    bblLeft = 0;
  }

  // ── Coverage + under-production, per drawn batch ─────────────────────────────
  const batchById = new Map(input.batches.map((b) => [b.batchId, b]));
  const candById = new Map(input.candidates.map((c) => [c.allocationId, c]));

  // Contract bbl credited per batch this shipment — a deposit holder legitimately
  // consuming their own reserve should not warn about stranding themselves.
  const contractCreditByBatch = new Map<string, number>();
  for (const cr of credits) {
    if (cr.allocationId == null) continue;
    const cand = candById.get(cr.allocationId);
    if (cand && isDepositBacked(cand.channel)) {
      contractCreditByBatch.set(cand.batchId, (contractCreditByBatch.get(cand.batchId) ?? 0) + cr.bbl);
    }
  }

  for (const draw of input.perBatchDrawBbl) {
    const batch = batchById.get(draw.batchId);
    if (!batch) continue;
    const res = batchReserve(batch);

    const fulfilledOwnReserve = contractCreditByBatch.get(draw.batchId) ?? 0;
    const reserveForOthers = Math.max(0, res.reservedForContractBbl - fulfilledOwnReserve);
    const onHandAfter = res.onHandBbl - draw.drawBbl;
    if (onHandAfter < reserveForOthers - EPS) {
      warnings.push({
        type: "guarantee_coverage",
        batchId: draw.batchId,
        reservedBbl: round4(reserveForOthers),
        onHandAfterBbl: round4(onHandAfter),
        drawBbl: round4(draw.drawBbl),
      });
    }

    if (res.underCovered) {
      warnings.push({
        type: "reserve_shortfall",
        batchId: draw.batchId,
        onHandBbl: round4(res.onHandBbl),
        owedBbl: round4(res.reservedForContractBbl),
      });
    }
  }

  return { credits, warnings };
}

export interface PlannedWrite {
  batchId: string;
  allocationId: string | null; // null → over-delivery / un-allocated row
  channel: string;
  bbl: number;
  qty: number;
  overAllocation: boolean;
}

/**
 * Expand a ShipmentPlan's credits into concrete export-row writes: an allocation
 * credit is attributed to that allocation's batch (logical fulfillment); the
 * over-delivery bucket is split across the physically drawn batches proportional
 * to how much each was drawn. Quantity is then distributed across all rows in
 * proportion to volume, with the last row taking the rounding remainder. Pure.
 */
export function planCreditedWrites(
  plan: ShipmentPlan,
  args: {
    candidates: ShipmentCandidate[];
    depleted: { batchId: string; depletedQty: number }[];
    quantity: number;
    overDeliveryChannel: string;
  }
): PlannedWrite[] {
  const { candidates, depleted, quantity, overDeliveryChannel } = args;
  const candById = new Map(candidates.map((c) => [c.allocationId, c]));
  const totalDrawQty = depleted.reduce((s, d) => s + d.depletedQty, 0);

  const writes: PlannedWrite[] = [];
  for (const cr of plan.credits) {
    if (cr.allocationId) {
      const cand = candById.get(cr.allocationId);
      if (!cand) continue;
      writes.push({ batchId: cand.batchId, allocationId: cr.allocationId, channel: cand.channel, bbl: cr.bbl, qty: 0, overAllocation: false });
    } else if (totalDrawQty > 0) {
      for (const d of depleted) {
        const portion = cr.bbl * (d.depletedQty / totalDrawQty);
        if (portion <= EPS) continue;
        writes.push({ batchId: d.batchId, allocationId: null, channel: overDeliveryChannel, bbl: round4(portion), qty: 0, overAllocation: cr.overAllocation });
      }
    }
  }

  const totalWriteBbl = writes.reduce((s, w) => s + w.bbl, 0) || 1;
  let qtyAssigned = 0;
  writes.forEach((w, i) => {
    w.qty = i === writes.length - 1 ? round4(quantity - qtyAssigned) : round4((w.bbl / totalWriteBbl) * quantity);
    qtyAssigned += w.qty;
  });
  return writes;
}

// ── Write-off assessment ─────────────────────────────────────────────────────
//
// "Writing off" an allocation forgives whatever is still owed on it and marks it
// fulfilled — used to close out a contract that fell short (e.g. a batch that
// under-yielded, or beer that shipped elsewhere). No refund is issued; it is a
// bookkeeping decision. Forgiving a small remainder is routine (shrinkage
// rounding), so we only warn when the forgiven amount is a large share of the
// entitlement — a give-away that should be a conscious choice.

/** Warn when the write-off forgives more than this fraction of the entitlement. */
export const WRITE_OFF_WARN_FRACTION = 0.1; // 10%

export interface WriteOffAssessment {
  entitlementBbl: number;    // what the allocation is owed: contract → A (if complete) else B; soft → S
  exportedBbl: number;       // already delivered
  remainingBbl: number;      // max(0, entitlement − exported) — the amount that would be forgiven
  fraction: number;          // remaining / entitlement (0 when entitlement is 0)
  warnFraction: number;      // threshold used
  exceedsTolerance: boolean; // remaining share is above warnFraction — surface a warning
  fullyDelivered: boolean;   // nothing meaningful left to forgive
}

/**
 * Assess a prospective write-off from an allocation's already-computed reserve
 * fields (the shape the allocations API returns). Pure and side-effect free, so
 * both the write-off route and the Export Bay UI derive the same remainder and
 * tolerance verdict without a round-trip.
 */
export function assessWriteOff(input: {
  depositBacked: boolean;
  bookedBbl: number | null;
  finalEntitlementBbl: number | null;
  realizableBbl: number;
  exportedBbl: number;
  warnFraction?: number;
}): WriteOffAssessment {
  const warnFraction = input.warnFraction ?? WRITE_OFF_WARN_FRACTION;
  // Contract entitlement: the final actual owed (A) once the batch is complete;
  // otherwise the pre-paid booked amount (B). Soft: the produced-so-far share.
  const entitlementBbl = input.depositBacked
    ? (input.finalEntitlementBbl ?? input.bookedBbl ?? input.realizableBbl)
    : input.realizableBbl;
  const remainingBbl = Math.max(0, entitlementBbl - input.exportedBbl);
  const fraction = entitlementBbl > EPS ? remainingBbl / entitlementBbl : 0;
  return {
    entitlementBbl: round4(entitlementBbl),
    exportedBbl: round4(input.exportedBbl),
    remainingBbl: round4(remainingBbl),
    fraction: round4(fraction),
    warnFraction,
    exceedsTolerance: fraction > warnFraction + EPS,
    fullyDelivered: remainingBbl <= EPS,
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
