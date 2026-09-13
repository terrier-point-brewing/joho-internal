import { describe, it, expect } from "vitest";
import { deriveCommitmentStage, type StageAllocation } from "./commitmentStage";

function alloc(over: Partial<StageAllocation> = {}): StageAllocation {
  return { batchStatus: "planning", producedBbl: 0, exportedBbl: 0, owedBbl: 0, writtenOff: false, ...over };
}

describe("deriveCommitmentStage", () => {
  it("cancelled is the one stored decision that wins outright", () => {
    expect(deriveCommitmentStage({ storedStatus: "cancelled", allocations: [alloc({ exportedBbl: 9, owedBbl: 9, batchStatus: "complete" })] })).toBe("cancelled");
  });

  it("no allocation → needs a batch, whatever status was stored", () => {
    expect(deriveCommitmentStage({ storedStatus: "open", allocations: [] })).toBe("unplanned");
    expect(deriveCommitmentStage({ storedStatus: "fulfilled", allocations: [] })).toBe("unplanned");
  });

  it("walks the pipeline: planned → brewing → packaged → shipping", () => {
    expect(deriveCommitmentStage({ storedStatus: "open", allocations: [alloc()] })).toBe("planned");
    expect(deriveCommitmentStage({ storedStatus: "open", allocations: [alloc({ batchStatus: "fermenting" })] })).toBe("brewing");
    expect(deriveCommitmentStage({ storedStatus: "open", allocations: [alloc({ batchStatus: "conditioning", producedBbl: 3.77, owedBbl: 2.83 })] })).toBe("packaged");
    expect(deriveCommitmentStage({ storedStatus: "open", allocations: [alloc({ batchStatus: "conditioning", producedBbl: 3.77, owedBbl: 2.83, exportedBbl: 2.65 })] })).toBe("shipping");
  });

  it("B-020 Oktoberfest: fully shipped but never pressed Complete → delivered, not stuck open", () => {
    const stage = deriveCommitmentStage({
      storedStatus: "open",
      allocations: [alloc({ batchStatus: "fermenting", producedBbl: 37.1, owedBbl: 18.55, exportedBbl: 18.56 })],
    });
    expect(stage).toBe("delivered");
  });

  it("fulfilled only once the batch is complete (owed is final)", () => {
    expect(deriveCommitmentStage({
      storedStatus: "open",
      allocations: [alloc({ batchStatus: "complete", producedBbl: 17.1, owedBbl: 17.1, exportedBbl: 17.1 })],
    })).toBe("fulfilled");
    // Within the 0.01 bbl tolerance counts as met (17.6069 vs 17.607).
    expect(deriveCommitmentStage({
      storedStatus: "open",
      allocations: [alloc({ batchStatus: "complete", producedBbl: 17.61, owedBbl: 17.607, exportedBbl: 17.6 })],
    })).toBe("fulfilled");
  });

  it("a stored 'fulfilled' does not override an under-delivered complete batch", () => {
    expect(deriveCommitmentStage({
      storedStatus: "fulfilled",
      allocations: [alloc({ batchStatus: "complete", producedBbl: 36.34, owedBbl: 24.53, exportedBbl: 11.5 })],
    })).toBe("shipping");
  });

  it("written off: every allocation forgiven → written_off; a forgiven sibling does not hold the deal open", () => {
    expect(deriveCommitmentStage({
      storedStatus: "open",
      allocations: [alloc({ batchStatus: "complete", producedBbl: 36.34, owedBbl: 24.53, exportedBbl: 11.5, writtenOff: true })],
    })).toBe("written_off");
    expect(deriveCommitmentStage({
      storedStatus: "open",
      allocations: [
        alloc({ batchStatus: "complete", producedBbl: 20, owedBbl: 10, exportedBbl: 10 }),
        alloc({ batchStatus: "complete", producedBbl: 20, owedBbl: 5, exportedBbl: 1, writtenOff: true }),
      ],
    })).toBe("fulfilled");
  });

  it("a deal split across two batches is only as far along as its slowest live allocation", () => {
    expect(deriveCommitmentStage({
      storedStatus: "open",
      allocations: [
        alloc({ batchStatus: "complete", producedBbl: 20, owedBbl: 10, exportedBbl: 10 }),
        alloc({ batchStatus: "fermenting" }),
      ],
    })).toBe("shipping");
  });
});
