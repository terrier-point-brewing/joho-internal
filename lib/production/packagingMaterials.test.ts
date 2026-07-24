// lib/production/packagingMaterials.test.ts
import { describe, it, expect } from "vitest";
import { computeMaterialCost, type MaterialTxnInput } from "./packagingMaterials";

// $0.15 can, $0.05 lid, $0.02 label, $0.30 paktech(4), $0.40 tray(24)
const can = { role: "container" as const, name: "12oz Can", unitCostDollars: 0.15, canCount: null };
const lid = { role: "lid" as const, name: "Lid", unitCostDollars: 0.05, canCount: null };
const label = { role: "label" as const, name: "Label", unitCostDollars: 0.02, canCount: null };
const paktech4 = { role: "paktech" as const, name: "PakTech 4", unitCostDollars: 0.30, canCount: 4 };
const tray24 = { role: "tray" as const, name: "Tray 24", unitCostDollars: 0.40, canCount: 24 };

describe("computeMaterialCost", () => {
  it("loose cans: only container+lid+label, no paktech/tray", () => {
    const txn: MaterialTxnInput = { format: "loose", packages: 100, unitsPerPackage: 1, components: [can, lid, label] };
    // 100 cans × (15+5+2) = 100 × 22 = 2200 cents
    expect(computeMaterialCost([txn])).toEqual({ totalCents: 2200, missingCostNames: [] });
  });

  it("6-pack: container/lid/label × unitsPerPackage + 1 paktech per package", () => {
    const paktech6 = { role: "paktech" as const, name: "PakTech 6", unitCostDollars: 0.30, canCount: 6 };
    const txn: MaterialTxnInput = { format: "6-pack", packages: 10, unitsPerPackage: 6, components: [can, lid, label, paktech6] };
    // cans/lids/labels: 60 each → 60×15 + 60×5 + 60×2 = 900+300+120 = 1320
    // paktech: 10 packages × 1 = 10 × 30 = 300 ; total 1620
    expect(computeMaterialCost([txn])).toEqual({ totalCents: 1620, missingCostNames: [] });
  });

  it("case: 24 cans/case, 6 paktechs/case (24/4), 1 tray/case", () => {
    const txn: MaterialTxnInput = { format: "case", packages: 2, unitsPerPackage: 24, components: [can, lid, label, paktech4, tray24] };
    // cans/lids/labels: 48 each → 48×15 + 48×5 + 48×2 = 720+240+96 = 1056
    // paktech: 2 × (24/4=6) = 12 → 12×30 = 360
    // tray: 2 × 1 = 2 → 2×40 = 80 ; total 1496
    expect(computeMaterialCost([txn])).toEqual({ totalCents: 1496, missingCostNames: [] });
  });

  it("null unit_cost on a consumed component → billed $0 and named once (deduped)", () => {
    const noCostCan = { role: "container" as const, name: "12oz Can", unitCostDollars: null, canCount: null };
    const t1: MaterialTxnInput = { format: "loose", packages: 100, unitsPerPackage: 1, components: [noCostCan, lid] };
    const t2: MaterialTxnInput = { format: "loose", packages: 50, unitsPerPackage: 1, components: [noCostCan, lid] };
    // cans billed $0; lids: 150 × 5 = 750
    expect(computeMaterialCost([t1, t2])).toEqual({ totalCents: 750, missingCostNames: ["12oz Can"] });
  });

  it("does not warn about a null-cost component that is never consumed (qty 0)", () => {
    const noCostTray = { role: "tray" as const, name: "Tray 24", unitCostDollars: null, canCount: 24 };
    // loose format never consumes a tray, so a null-cost tray must not warn
    const txn: MaterialTxnInput = { format: "loose", packages: 10, unitsPerPackage: 1, components: [can, noCostTray] };
    expect(computeMaterialCost([txn])).toEqual({ totalCents: 150, missingCostNames: [] });
  });

  it("empty input and zero packages → 0 cents, no warnings", () => {
    expect(computeMaterialCost([])).toEqual({ totalCents: 0, missingCostNames: [] });
    expect(computeMaterialCost([{ format: "loose", packages: 0, unitsPerPackage: 1, components: [can] }]))
      .toEqual({ totalCents: 0, missingCostNames: [] });
  });
});
