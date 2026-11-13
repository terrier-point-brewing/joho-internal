import { describe, it, expect } from "vitest";
import { isInPlaceConversion, resolveInPlaceConversionVolume } from "./inPlaceConversion";
import { computeTankVolumes, type LedgerTransfer } from "./volumeLedger";

const t = (over: Partial<LedgerTransfer>): LedgerTransfer => ({
  batch_id: "src", from_tank_id: null, to_tank_id: null, to_batch_id: null,
  volume_bbl: 0, shrinkage_bbl: 0, transferred_at: "2026-11-01T00:00:00Z", ...over,
});

// B-069 as it stood on 2026-11-13: 40 bbl into brite 33, four kegging runs out.
const b069: LedgerTransfer[] = [
  t({ from_tank_id: "fv11", to_tank_id: "bt33", volume_bbl: 40, transferred_at: "2026-11-04T00:00:00Z" }),
  t({ from_tank_id: "bt33", to_tank_id: "keg", volume_bbl: 4, transferred_at: "2026-11-13T15:22:12Z" }),
  t({ from_tank_id: "bt33", to_tank_id: "keg", volume_bbl: 1, transferred_at: "2026-11-13T15:22:33Z" }),
  t({ from_tank_id: "bt33", to_tank_id: "keg", volume_bbl: 1.6658266129032258, transferred_at: "2026-11-13T15:22:34Z" }),
  t({ from_tank_id: "bt33", to_tank_id: "keg", volume_bbl: 1.6658266129032258, transferred_at: "2026-11-13T16:13:08Z" }),
];

describe("isInPlaceConversion", () => {
  it("is a conversion whose source and destination are the same tank", () => {
    expect(isInPlaceConversion({ transfer_type: "conversion", from_tank_id: "a", to_tank_id: "a" })).toBe(true);
  });
  it("is not a conversion into another tank, nor an in-place conditioning switch", () => {
    expect(isInPlaceConversion({ transfer_type: "conversion", from_tank_id: "a", to_tank_id: "b" })).toBe(false);
    expect(isInPlaceConversion({ transfer_type: "transfer", from_tank_id: "a", to_tank_id: "a" })).toBe(false);
    expect(isInPlaceConversion({ transfer_type: "conversion", from_tank_id: null, to_tank_id: null })).toBe(false);
  });
});

describe("resolveInPlaceConversionVolume", () => {
  it("delivers everything in the tank — not a typed figure that leaves dust behind", () => {
    const r = resolveInPlaceConversionVolume({ batchId: "src", batchVolumeBbl: 40, tankId: "bt33", shrinkageBbl: 0, ledger: b069 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.deliveredBbl).toBeCloseTo(31.6683468, 6);
    expect(r.inTankBbl).toBeCloseTo(31.6683468, 6);
  });

  it("takes declared shrinkage out of what the new batch receives", () => {
    const r = resolveInPlaceConversionVolume({ batchId: "src", batchVolumeBbl: 40, tankId: "bt33", shrinkageBbl: 0.5, ledger: b069 });
    expect(r.ok && r.deliveredBbl).toBeCloseTo(31.1683468, 6);
  });

  it("falls back to the headline volume for a batch the ledger has never seen", () => {
    const r = resolveInPlaceConversionVolume({ batchId: "src", batchVolumeBbl: 20, tankId: "fv1", shrinkageBbl: 0, ledger: [] });
    expect(r).toEqual({ ok: true, inTankBbl: 20, deliveredBbl: 20 });
  });

  it("refuses when the batch holds nothing in that tank", () => {
    const r = resolveInPlaceConversionVolume({ batchId: "src", batchVolumeBbl: 40, tankId: "bt99", shrinkageBbl: 0, ledger: b069 });
    expect(r.ok).toBe(false);
  });

  it("refuses when shrinkage would swallow the whole tank", () => {
    const r = resolveInPlaceConversionVolume({ batchId: "src", batchVolumeBbl: 40, tankId: "bt33", shrinkageBbl: 32, ledger: b069 });
    expect(r.ok).toBe(false);
  });
});

describe("the ledger after an in-place conversion", () => {
  // The row as the transfers route writes it: same tank both ends, pointed at
  // the child. The source must read empty and the child must read full.
  const delivered = 31.668346774193548;
  const after: LedgerTransfer[] = [
    ...b069,
    t({ from_tank_id: "bt33", to_tank_id: "bt33", to_batch_id: "child", volume_bbl: delivered, transferred_at: "2026-11-13T16:26:41Z" }),
  ];

  it("leaves the source with nothing in the tank", () => {
    expect(computeTankVolumes("src", 40, after)["bt33"]).toBeUndefined();
  });

  it("puts the whole volume in the same tank under the child", () => {
    expect(computeTankVolumes("child", 31.67, after)["bt33"]).toBeCloseTo(delivered, 9);
  });
});
