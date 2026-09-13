import { isFullyDelivered } from "./allocationDelivery";

/**
 * Where a commitment is, derived from its allocations rather than stored.
 *
 * `commitments.status` only ever held what code happened to write: "open",
 * then "fulfilled" once a batch was manually completed and every drop had
 * shipped. A batch that shipped out fully but was never pressed Complete kept
 * its commitment "open" forever (B-020 Oktoberfest, B-056 Pilsner), and
 * nothing said "brewing" or "delivered" in between. The stored column keeps
 * only the human decisions — cancelled, and the legacy fulfilled cache — and
 * this stage is what the operator sees.
 *
 * Stages, in the order a deal moves through them:
 *   unplanned   no batch allocated yet — the scheduler still owes it a brew
 *   planned     allocated on a batch that has not been brewed
 *   brewing     the batch is in the brewhouse / fermenter / brite, nothing packaged
 *   packaged    beer is in containers, nothing shipped yet
 *   shipping    some shipped, less than owed
 *   delivered   shipped ≥ owed, but the batch is not complete so owed can still move
 *   fulfilled   shipped ≥ owed on a complete batch (final), or written off
 *   written_off every allocation was written off — closed without full delivery
 *   cancelled   the human decision
 */
export type CommitmentStage =
  | "cancelled"
  | "unplanned"
  | "planned"
  | "brewing"
  | "packaged"
  | "shipping"
  | "delivered"
  | "fulfilled"
  | "written_off";

export interface StageAllocation {
  batchStatus: string;
  producedBbl: number;
  exportedBbl: number;
  owedBbl: number;
  writtenOff: boolean;
}

const PRE_BREW = new Set(["planning", "backlog"]);

export function deriveCommitmentStage(input: {
  storedStatus: string | null;
  allocations: StageAllocation[];
}): CommitmentStage {
  if (input.storedStatus === "cancelled") return "cancelled";
  const allocs = input.allocations;
  if (allocs.length === 0) return "unplanned";

  const live = allocs.filter((a) => !a.writtenOff);
  if (live.length === 0) return "written_off";

  // Every live allocation delivered on a complete batch → final. A written-off
  // sibling does not hold the deal open: its remainder was forgiven.
  const allDelivered = live.every((a) => isFullyDelivered(a.exportedBbl, a.owedBbl));
  const allComplete = live.every((a) => a.batchStatus === "complete");
  if (allDelivered && allComplete) return "fulfilled";
  if (allDelivered) return "delivered";

  if (live.some((a) => a.exportedBbl > 0)) return "shipping";
  if (live.some((a) => a.producedBbl > 0)) return "packaged";
  if (live.some((a) => !PRE_BREW.has(a.batchStatus))) return "brewing";
  return "planned";
}

/** Stages that still need something to happen — the scheduler's "open" set. */
export const ACTIVE_STAGES: ReadonlySet<CommitmentStage> = new Set([
  "unplanned", "planned", "brewing", "packaged", "shipping", "delivered",
]);
