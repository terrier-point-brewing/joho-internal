import { describe, it, expect } from "vitest";
import { computeTankVolumes, computeLocationBreakdown, hasLedgerActivity, type LedgerTransfer } from "./volumeLedger";

// Minimal transfer factory — only the fields the ledger math reads.
function tx(over: Partial<LedgerTransfer>): LedgerTransfer {
  return {
    batch_id: "self",
    from_tank_id: null,
    to_tank_id: null,
    to_batch_id: null,
    volume_bbl: 0,
    shrinkage_bbl: 0,
    transferred_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

const FERM = "ferm-1";
const BRITE = "brite-1";
const SRC_FERM = "src-ferm";
const tankTypes: Record<string, string> = {
  [FERM]: "fermenter",
  [BRITE]: "brite",
  [SRC_FERM]: "fermenter",
};

describe("computeTankVolumes — normal (own) ledger", () => {
  it("seeds first from-tank with original volume when no arrival is recorded", () => {
    const transfers = [
      tx({ batch_id: "b1", from_tank_id: FERM, to_tank_id: BRITE, volume_bbl: 20, shrinkage_bbl: 1 }),
    ];
    // FERM seeded with 30, then -21 (20 + 1 shrink) = 9 left; BRITE +20.
    const vols = computeTankVolumes("b1", 30, transfers);
    expect(vols[FERM]).toBeCloseTo(9, 5);
    expect(vols[BRITE]).toBeCloseTo(20, 5);
  });

  it("returns {} for a batch with no own transfers and no conversion inflows", () => {
    expect(computeTankVolumes("ghost", 25, [])).toEqual({});
  });
});

describe("computeTankVolumes — conversion-target batch (inflow via to_batch_id)", () => {
  // Mirrors real batch B-038: born from a conversion, volume recorded on the
  // SOURCE batch's ledger with to_batch_id pointing at this batch.
  const conversionInflow = tx({
    batch_id: "B-028",        // source batch owns the row
    to_batch_id: "B-038",     // credited to the target
    from_tank_id: SRC_FERM,   // source's tank
    to_tank_id: BRITE,        // target's destination tank
    volume_bbl: 24.5,
    shrinkage_bbl: 0.5,
  });

  it("credits the destination tank of an inbound conversion to the target batch", () => {
    const vols = computeTankVolumes("B-038", 25, [conversionInflow]);
    expect(vols[BRITE]).toBeCloseTo(24.5, 5);
    // The source's tank must NOT be attributed to the target.
    expect(vols[SRC_FERM]).toBeUndefined();
  });

  it("does not credit the source batch with its conversion destination tank", () => {
    const vols = computeTankVolumes("B-028", 40, [conversionInflow]);
    // Source loses 24.5 + 0.5 shrink from its seeded tank; brite stays with target.
    expect(vols[BRITE]).toBeUndefined();
  });

  it("subtracts a later own outbound transfer from the converted-in volume", () => {
    const packageOut = tx({
      batch_id: "B-038",
      from_tank_id: BRITE,
      to_tank_id: "cold-1",
      volume_bbl: 10,
      transferred_at: "2026-02-01T00:00:00Z",
    });
    const vols = computeTankVolumes("B-038", 25, [conversionInflow, packageOut]);
    expect(vols[BRITE]).toBeCloseTo(14.5, 5);
  });
});

describe("computeLocationBreakdown — conversion-target batch", () => {
  const conversionInflow = tx({
    batch_id: "B-028",
    to_batch_id: "B-038",
    from_tank_id: SRC_FERM,
    to_tank_id: BRITE,
    volume_bbl: 24.5,
    shrinkage_bbl: 0.5,
  });

  it("reports converted-in volume in its brite tank even though the batch is assigned", () => {
    const bd = computeLocationBreakdown("B-038", 25, [conversionInflow], tankTypes, /* isAssigned */ true);
    expect(bd.brite).toBeCloseTo(24.5, 5);
    expect(bd.backlog).toBe(0);
    // Shrinkage on the inbound row belongs to the source, not the target.
    expect(bd.shrinkage).toBe(0);
  });

  it("does not fall back to backlog=originalVol when the only ledger activity is an inbound conversion", () => {
    const bd = computeLocationBreakdown("B-038", 25, [conversionInflow], tankTypes, /* isAssigned */ false);
    expect(bd.brite).toBeCloseTo(24.5, 5);
    expect(bd.backlog).toBe(0);
  });
});

describe("hasLedgerActivity — separates 'unknown' from 'known to be empty'", () => {
  const BREWHOUSE = "bh-1";

  it("is false for a batch the ledger has never heard of", () => {
    expect(hasLedgerActivity("b1", [])).toBe(false);
    expect(hasLedgerActivity("b1", [tx({ batch_id: "someone-else" })])).toBe(false);
  });

  it("is true for a batch whose own transfers exist", () => {
    expect(hasLedgerActivity("b1", [tx({ batch_id: "b1" })])).toBe(true);
  });

  it("is true for a conversion-born batch, whose only row belongs to the source", () => {
    expect(hasLedgerActivity("b1", [tx({ batch_id: "src", to_batch_id: "b1" })])).toBe(true);
  });

  // The B-059 / B-060 shape: a 0 BBL transfer out of the brewhouse. The source
  // still nets its full volume, the destination nets nothing, and the batch is
  // assigned to both tanks. computeTankVolumes alone cannot tell a caller that
  // the destination is genuinely empty rather than simply unrecorded.
  it("lets a caller tell an empty tank apart from an unrecorded one", () => {
    const zeroMove = tx({ batch_id: "b1", from_tank_id: BREWHOUSE, to_tank_id: FERM, volume_bbl: 0 });
    const vols = computeTankVolumes("b1", 20, [zeroMove]);

    expect(vols[BREWHOUSE]).toBeCloseTo(20, 5);
    expect(vols[FERM]).toBeUndefined();
    // Because the ledger DOES describe this batch, the undefined above means
    // "nothing here" — not "fall back to the batch's 20 BBL".
    expect(hasLedgerActivity("b1", [zeroMove])).toBe(true);
  });

  it("stays true for a batch drained to zero everywhere — only computeTankVolumes goes quiet", () => {
    const drained = [
      tx({ batch_id: "b1", to_tank_id: FERM, volume_bbl: 20, transferred_at: "2026-01-01T00:00:00Z" }),
      tx({ batch_id: "b1", from_tank_id: FERM, to_tank_id: null, volume_bbl: 20, transferred_at: "2026-01-02T00:00:00Z" }),
    ];
    expect(computeTankVolumes("b1", 20, drained)).toEqual({});
    // Still true: the batch is fully packaged out, not unrecorded. A caller
    // gating on this reports 0, instead of resurrecting 20 BBL onto its tank.
    expect(hasLedgerActivity("b1", drained)).toBe(true);
  });
});
