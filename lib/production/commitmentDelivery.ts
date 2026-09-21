// lib/production/commitmentDelivery.ts
//
// Where a commitment stands: produced → owed → shipped → remaining, and its
// stage. ONE function, used by Intake → Commitments (the commitments API) and
// by Export → Partner Ledger (buildPartnerLedger). They used to orchestrate the
// same primitives separately — same deal, two chances to disagree.

import { owedBbl } from "./allocationDelivery";
import { deriveCommitmentStage } from "./commitmentStage";
import type { CommitmentStage } from "./commitmentStage";

export interface DeliveryAllocationInput {
  id: string;
  batch_id: string;
  channel: string;
  percentage: number | string;
  batch_status: string | null;
  /** Remaining volume forgiven (written_off_at / written_off_bbl set). */
  written_off: boolean;
}

export interface AllocationDeliveryFigures {
  id: string;
  produced_bbl: number;
  owed_bbl: number;
  exported_bbl: number;
  remaining_bbl: number;
  written_off: boolean;
}

export interface CommitmentDelivery {
  allocations: AllocationDeliveryFigures[];
  produced_bbl: number;
  owed_bbl: number;
  exported_bbl: number;
  /** Owed minus shipped, leaving out written-off allocations. */
  remaining_bbl: number;
  stage: CommitmentStage;
}

/** Figures are unrounded — round at the edge, never before deriving the stage. */
export function commitmentDelivery(input: {
  storedStatus: string | null;
  bookedBbl: number;
  allocations: DeliveryAllocationInput[];
  producedByBatch: Map<string, number>;
  exportedByAllocation: Map<string, number>;
}): CommitmentDelivery {
  const booked = input.bookedBbl > 0 ? input.bookedBbl : null;
  const allocations = input.allocations.map((a): AllocationDeliveryFigures => {
    const produced = input.producedByBatch.get(a.batch_id) ?? 0;
    const owed = owedBbl({ channel: a.channel, percentage: Number(a.percentage), producedBbl: produced, bookedBbl: booked });
    const exported = input.exportedByAllocation.get(a.id) ?? 0;
    return { id: a.id, produced_bbl: produced, owed_bbl: owed, exported_bbl: exported, remaining_bbl: Math.max(0, owed - exported), written_off: a.written_off };
  });
  const live = allocations.filter((a) => !a.written_off);
  return {
    allocations,
    produced_bbl: allocations.reduce((s, a) => s + a.produced_bbl, 0),
    owed_bbl: allocations.reduce((s, a) => s + a.owed_bbl, 0),
    exported_bbl: allocations.reduce((s, a) => s + a.exported_bbl, 0),
    remaining_bbl: live.reduce((s, a) => s + a.remaining_bbl, 0),
    stage: deriveCommitmentStage({
      storedStatus: input.storedStatus,
      allocations: allocations.map((a, i) => ({
        exportedBbl: a.exported_bbl,
        owedBbl: a.owed_bbl,
        batchComplete: input.allocations[i].batch_status === "complete",
        writtenOff: a.written_off,
      })),
    }),
  };
}
