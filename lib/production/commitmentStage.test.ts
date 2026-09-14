import { describe, it, expect } from "vitest";
import { allocationIsFinal, deriveCommitmentStage, type StageAllocation } from "./commitmentStage";

function alloc(over: Partial<StageAllocation> = {}): StageAllocation {
  return { exportedBbl: 0, owedBbl: 0, batchComplete: false, writtenOff: false, ...over };
}

describe("deriveCommitmentStage", () => {
  it("cancelled is the one stored decision that wins outright", () => {
    expect(deriveCommitmentStage({ storedStatus: "cancelled", allocations: [alloc({ exportedBbl: 9, owedBbl: 9, batchComplete: true })] })).toBe("cancelled");
  });

  it("no allocation, nothing produced, or partly shipped → open, whatever status was stored", () => {
    expect(deriveCommitmentStage({ storedStatus: "fulfilled", allocations: [] })).toBe("open");
    expect(deriveCommitmentStage({ storedStatus: "open", allocations: [alloc()] })).toBe("open");
    expect(deriveCommitmentStage({ storedStatus: "open", allocations: [alloc({ owedBbl: 2.83, exportedBbl: 2.65 })] })).toBe("open");
    expect(deriveCommitmentStage({ storedStatus: "fulfilled", allocations: [alloc({ owedBbl: 24.53, exportedBbl: 11.5, batchComplete: true })] })).toBe("open");
  });

  it("B-056: everything owed so far has shipped (and then some), but the batch is not closed out → open", () => {
    const a = alloc({ owedBbl: 19.71, exportedBbl: 24.39, batchComplete: false });
    expect(allocationIsFinal(a)).toBe(false);
    expect(deriveCommitmentStage({ storedStatus: "open", allocations: [a] })).toBe("open");
    // B-020 Oktoberfest, fully shipped but never pressed Complete: still open.
    expect(deriveCommitmentStage({ storedStatus: "open", allocations: [alloc({ owedBbl: 18.55, exportedBbl: 18.56 })] })).toBe("open");
  });

  it("closes only once the batch is complete and everything owed has shipped", () => {
    expect(deriveCommitmentStage({ storedStatus: "open", allocations: [alloc({ owedBbl: 17.1, exportedBbl: 17.1, batchComplete: true })] })).toBe("closed");
    // Within the 0.01 bbl tolerance counts.
    expect(deriveCommitmentStage({ storedStatus: "open", allocations: [alloc({ owedBbl: 17.607, exportedBbl: 17.6, batchComplete: true })] })).toBe("closed");
    // Complete but short: open (until written off).
    expect(deriveCommitmentStage({ storedStatus: "open", allocations: [alloc({ owedBbl: 13.75, exportedBbl: 9, batchComplete: true })] })).toBe("open");
  });

  it("written off closes the deal; a written-off sibling does not hold it open", () => {
    expect(deriveCommitmentStage({ storedStatus: "open", allocations: [alloc({ owedBbl: 24.53, exportedBbl: 11.5, writtenOff: true })] })).toBe("closed");
    expect(deriveCommitmentStage({
      storedStatus: "open",
      allocations: [alloc({ owedBbl: 10, exportedBbl: 10, batchComplete: true }), alloc({ owedBbl: 5, exportedBbl: 1, writtenOff: true })],
    })).toBe("closed");
  });
});
