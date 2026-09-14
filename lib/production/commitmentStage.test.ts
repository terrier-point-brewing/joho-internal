import { describe, it, expect } from "vitest";
import { deriveCommitmentStage, type StageAllocation } from "./commitmentStage";

function alloc(over: Partial<StageAllocation> = {}): StageAllocation {
  return { exportedBbl: 0, owedBbl: 0, writtenOff: false, ...over };
}

describe("deriveCommitmentStage", () => {
  it("cancelled is the one stored decision that wins outright", () => {
    expect(deriveCommitmentStage({ storedStatus: "cancelled", allocations: [alloc({ exportedBbl: 9, owedBbl: 9 })] })).toBe("cancelled");
  });

  it("no allocation, nothing produced, or partly shipped → open, whatever status was stored", () => {
    expect(deriveCommitmentStage({ storedStatus: "fulfilled", allocations: [] })).toBe("open");
    expect(deriveCommitmentStage({ storedStatus: "open", allocations: [alloc()] })).toBe("open");
    expect(deriveCommitmentStage({ storedStatus: "open", allocations: [alloc({ owedBbl: 2.83, exportedBbl: 2.65 })] })).toBe("open");
    // A stored "fulfilled" does not close an under-delivered deal.
    expect(deriveCommitmentStage({ storedStatus: "fulfilled", allocations: [alloc({ owedBbl: 24.53, exportedBbl: 11.5 })] })).toBe("open");
  });

  it("everything owed shipped → closed, within the 0.01 bbl tolerance", () => {
    expect(deriveCommitmentStage({ storedStatus: "open", allocations: [alloc({ owedBbl: 17.1, exportedBbl: 17.1 })] })).toBe("closed");
    expect(deriveCommitmentStage({ storedStatus: "open", allocations: [alloc({ owedBbl: 17.607, exportedBbl: 17.6 })] })).toBe("closed");
    // B-020 Oktoberfest: fully shipped, batch never pressed Complete — still closed.
    expect(deriveCommitmentStage({ storedStatus: "open", allocations: [alloc({ owedBbl: 18.55, exportedBbl: 18.56 })] })).toBe("closed");
  });

  it("written off closes the deal; a written-off sibling does not hold it open", () => {
    expect(deriveCommitmentStage({ storedStatus: "open", allocations: [alloc({ owedBbl: 24.53, exportedBbl: 11.5, writtenOff: true })] })).toBe("closed");
    expect(deriveCommitmentStage({
      storedStatus: "open",
      allocations: [alloc({ owedBbl: 10, exportedBbl: 10 }), alloc({ owedBbl: 5, exportedBbl: 1, writtenOff: true })],
    })).toBe("closed");
  });

  it("a deal split across two batches is open until every live allocation is delivered", () => {
    expect(deriveCommitmentStage({
      storedStatus: "open",
      allocations: [alloc({ owedBbl: 10, exportedBbl: 10 }), alloc({ owedBbl: 8, exportedBbl: 0 })],
    })).toBe("open");
  });
});
