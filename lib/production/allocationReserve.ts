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
  fulfilled: boolean;
}

export function allocationView(alloc: AllocationInput, batch: BatchInput): AllocationView {
  const depositBacked = isDepositBacked(alloc.channel);
  const realizableBbl = (alloc.percentage / 100) * batch.producedBbl;
  const complete = batch.status === "complete";
  const finalEntitlementBbl = complete ? realizableBbl : null;
  // Contract fulfillment is only meaningful once the batch is complete (A is
  // final). Soft channels have no deposit, so "fulfilled" is advisory: shipped
  // at least the produced-so-far share.
  const fulfilled = depositBacked
    ? complete && finalEntitlementBbl != null && alloc.exportedBbl >= finalEntitlementBbl - EPS
    : alloc.exportedBbl >= realizableBbl - EPS;
  return {
    bookedBbl: alloc.bookedBbl,
    realizableBbl,
    finalEntitlementBbl,
    exportedBbl: alloc.exportedBbl,
    depositBacked,
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
  const contract = batch.allocations.filter((a) => isDepositBacked(a.channel));
  const reservedForContractBbl = contract.reduce((s, a) => {
    const realizable = (a.percentage / 100) * batch.producedBbl;
    return s + Math.max(0, realizable - a.exportedBbl);
  }, 0);
  const onHandBbl = Math.max(0, batch.producedBbl - batch.totalExportedBbl);
  const freeToShipBbl = Math.max(0, onHandBbl - reservedForContractBbl);
  const guaranteedBbl = contract.reduce((s, a) => s + (a.bookedBbl ?? 0), 0);
  const underCovered = batch.producedBbl < guaranteedBbl - EPS;
  return { batchId: batch.batchId, producedBbl: batch.producedBbl, onHandBbl, reservedForContractBbl, freeToShipBbl, underCovered };
}

// ── Completion reconciliation (contract only) ────────────────────────────────

export interface CompletionReconciliation {
  finalEntitlementBbl: number;   // A = percentage × final produced
  overDeliveredBbl: number;      // max(0, E − A) — beer shipped beyond the final entitlement
  underDeliveredBbl: number;     // max(0, A − E) — beer still owed
  shrinkageShortfallBbl: number; // max(0, B − A) — paid-for but un-yielded → deposit refund basis
}

/**
 * At batch completion, reconcile a contract allocation's deposit (B) against the
 * final actual entitlement (A = percentage × final produced) and what shipped (E).
 * Returns null for soft channels (no deposit) or before the batch is complete
 * (A is not yet final). This is DERIVED and advisory — it proposes a shrinkage
 * refund basis; it does not issue anything.
 */
export function completionReconciliation(alloc: AllocationInput, batch: BatchInput): CompletionReconciliation | null {
  if (!isDepositBacked(alloc.channel)) return null;
  if (batch.status !== "complete") return null;
  const a = (alloc.percentage / 100) * batch.producedBbl;
  const b = alloc.bookedBbl ?? 0;
  const e = alloc.exportedBbl;
  return {
    finalEntitlementBbl: round4(a),
    overDeliveredBbl: round4(Math.max(0, e - a)),
    underDeliveredBbl: round4(Math.max(0, a - e)),
    shrinkageShortfallBbl: round4(Math.max(0, b - a)),
  };
}

// ── Shipment planning (crediting + warnings) ─────────────────────────────────

export type ShipmentWarning =
  // Draw on a batch would leave less than what other deposit holders are still owed.
  | { type: "guarantee_coverage"; batchId: string; reservedBbl: number; onHandAfterBbl: number; drawBbl: number }
  // Batch hasn't produced enough yet to cover its contract guarantees (shrinkage/yield risk).
  | { type: "under_production"; batchId: string; producedBbl: number; guaranteedBbl: number }
  // Shipped beyond every bookable claim (contract booked, with no soft allocation to absorb).
  | { type: "over_booked"; overBbl: number };

export interface ShipmentCandidate {
  allocationId: string;
  batchId: string;
  channel: AllocationChannel;
  bookedRemainingBbl: number | null; // contract: max(0, booked − exported); soft: null (uncapped)
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
    const cap = isDepositBacked(c.channel) ? Math.max(0, c.bookedRemainingBbl ?? 0) : Infinity;
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
      const guaranteedBbl = batch.allocations
        .filter((a) => isDepositBacked(a.channel))
        .reduce((s, a) => s + (a.bookedBbl ?? 0), 0);
      warnings.push({ type: "under_production", batchId: draw.batchId, producedBbl: round4(batch.producedBbl), guaranteedBbl: round4(guaranteedBbl) });
    }
  }

  return { credits, warnings };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
