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
 *   closed     nothing more ships: everything owed went out, or the remainder
 *              was written off
 *   cancelled  the human decision
 *
 * `commitments.status` keeps only that human decision. Its legacy
 * "fulfilled" / "in_progress" values are ignored here.
 */
export type CommitmentStage = "open" | "closed" | "cancelled";

export interface StageAllocation {
  exportedBbl: number;
  owedBbl: number;
  writtenOff: boolean;
}

export function deriveCommitmentStage(input: {
  storedStatus: string | null;
  allocations: StageAllocation[];
}): CommitmentStage {
  if (input.storedStatus === "cancelled") return "cancelled";
  const live = input.allocations.filter((a) => !a.writtenOff);
  if (input.allocations.length === 0) return "open";
  if (live.length === 0) return "closed";
  return live.every((a) => isFullyDelivered(a.exportedBbl, a.owedBbl)) ? "closed" : "open";
}
