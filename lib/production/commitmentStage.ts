import { isFullyDelivered } from "./allocationDelivery";

/**
 * Whether a commitment is still open, derived from its allocations rather
 * than stored.
 *
 * A reader of the ledger needs exactly one thing from a stage: is beer still
 * owed on this deal? Where the batch sits in the pipeline (planned, brewing,
 * packaged) changes nothing about that answer, and delivered / fulfilled /
 * written off are all the same answer — closed — with at most a warning
 * about how it closed (over- or under-delivered). Those warnings live in
 * lib/production/ledgerAttention, not here.
 *
 *   open       beer is still owed (no batch yet, brewing, or partly shipped)
 *   closed     the batch is complete and everything owed went out, or the
 *              remainder was written off
 *   cancelled  the human decision
 *
 * `commitments.status` keeps only that human decision. Its legacy
 * "fulfilled" / "in_progress" values are ignored here.
 */
export type CommitmentStage = "open" | "closed" | "cancelled";

export interface StageAllocation {
  exportedBbl: number;
  /** Owed so far: share of what has been produced, capped at the booking. */
  owedBbl: number;
  /** The batch is complete — closed out and drained; nothing more is coming. */
  batchComplete: boolean;
  writtenOff: boolean;
}

/**
 * A live allocation is done when everything owed so far has shipped AND the
 * batch is complete. While beer is still in tank the deal is open no matter
 * what has shipped: B-056 shipped 24.39 against 19.71 owed with 6.67 bbl
 * still in tank — that deal is open, because the batch is not closed out.
 */
export function allocationIsFinal(a: StageAllocation): boolean {
  if (a.writtenOff) return true;
  return a.batchComplete && isFullyDelivered(a.exportedBbl, a.owedBbl);
}

export function deriveCommitmentStage(input: {
  storedStatus: string | null;
  allocations: StageAllocation[];
}): CommitmentStage {
  if (input.storedStatus === "cancelled") return "cancelled";
  if (input.allocations.length === 0) return "open";
  return input.allocations.every(allocationIsFinal) ? "closed" : "open";
}
