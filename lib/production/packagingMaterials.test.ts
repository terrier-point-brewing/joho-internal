// lib/production/packagingMaterials.test.ts
import { describe, it, expect } from "vitest";
import { computeMaterialBreakdown, computeMaterialCost, type MaterialTxnInput } from "./packagingMaterials";

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

  it("null unit_cost_usd on a consumed component → billed $0 and named once (deduped)", () => {
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

describe("computeMaterialBreakdown", () => {
  it("itemizes each consumed component and sums to the same total as computeMaterialCost", () => {
    const txn: MaterialTxnInput = {
      format: "case", packages: 2, unitsPerPackage: 24,
      components: [can, lid, label, paktech4, tray24], label: "Fortnight 12oz Case",
    };
    const b = computeMaterialBreakdown([txn]);

    expect(b.totalCents).toBe(computeMaterialCost([txn]).totalCents);
    expect(b.transactions).toHaveLength(1);
    expect(b.transactions[0]).toMatchObject({
      label: "Fortnight 12oz Case", format: "case", packages: 2, unitsPerPackage: 24, subtotalCents: 1496,
    });
    expect(b.transactions[0].components).toEqual([
      { role: "container", name: "12oz Can", unitCostDollars: 0.15, quantity: 48, extendedCents: 720, missingCost: false },
      { role: "lid", name: "Lid", unitCostDollars: 0.05, quantity: 48, extendedCents: 240, missingCost: false },
      { role: "label", name: "Label", unitCostDollars: 0.02, quantity: 48, extendedCents: 96, missingCost: false },
      { role: "paktech", name: "PakTech 4", unitCostDollars: 0.30, quantity: 12, extendedCents: 360, missingCost: false },
      { role: "tray", name: "Tray 24", unitCostDollars: 0.40, quantity: 2, extendedCents: 80, missingCost: false },
    ]);
  });

  it("omits components a transaction never consumes", () => {
    const txn: MaterialTxnInput = { format: "loose", packages: 10, unitsPerPackage: 1, components: [can, tray24] };
    const b = computeMaterialBreakdown([txn]);
    expect(b.transactions[0].components.map((c) => c.role)).toEqual(["container"]);
  });

  it("flags a consumed component with no unit cost and bills it at $0", () => {
    const noCostCan = { role: "container" as const, name: "12oz Can", unitCostDollars: null, canCount: null };
    const b = computeMaterialBreakdown([
      { format: "loose", packages: 100, unitsPerPackage: 1, components: [noCostCan, lid] },
    ]);
    expect(b.transactions[0].components[0]).toMatchObject({ missingCost: true, extendedCents: 0, quantity: 100 });
    expect(b.missingCostNames).toEqual(["12oz Can"]);
    expect(b.totalCents).toBe(500);
  });

  it("keeps one entry per packaging run, each with its own subtotal", () => {
    const b = computeMaterialBreakdown([
      { format: "loose", packages: 100, unitsPerPackage: 1, components: [can], label: "A" },
      { format: "loose", packages: 50, unitsPerPackage: 1, components: [can], label: "B" },
    ]);
    expect(b.transactions.map((t) => t.subtotalCents)).toEqual([1500, 750]);
    expect(b.totalCents).toBe(2250);
  });
});

describe("packaging loss %", () => {
  it("grows containers/lids/labels but never paktechs or trays", () => {
    // The worked example from the spec: 300 cans filled across formats at 5%
    // loss → 315 cans, 315 lids, 315 labels consumed.
    const txn: MaterialTxnInput = {
      format: "case", packages: 12.5, unitsPerPackage: 24,
      components: [can, lid, label, paktech4, tray24], lossPct: 5,
    };
    const b = computeMaterialBreakdown([txn]);
    const qty = Object.fromEntries(b.transactions[0].components.map((c) => [c.role, c.quantity]));
    expect(qty.container).toBe(315);
    expect(qty.lid).toBe(315);
    expect(qty.label).toBe(315);
    // 12.5 cases × (24/4) paktechs and × 1 tray — untouched by the loss
    expect(qty.paktech).toBe(75);
    expect(qty.tray).toBe(13); // Math.round(12.5)
  });

  it("charges the grown quantity, not the filled one", () => {
    const base: MaterialTxnInput = { format: "loose", packages: 100, unitsPerPackage: 1, components: [can, lid, label] };
    expect(computeMaterialCost([base]).totalCents).toBe(2200);
    // 105 × (15+5+2) = 2310
    expect(computeMaterialCost([{ ...base, lossPct: 5 }]).totalCents).toBe(2310);
  });

  it("rounds to whole units", () => {
    // 33 × 1.05 = 34.65 → 35
    const b = computeMaterialBreakdown([
      { format: "loose", packages: 33, unitsPerPackage: 1, components: [can], lossPct: 5 },
    ]);
    expect(b.transactions[0].components[0].quantity).toBe(35);
  });

  it("is a no-op at 0 or undefined", () => {
    const base: MaterialTxnInput = { format: "loose", packages: 100, unitsPerPackage: 1, components: [can, lid, label] };
    expect(computeMaterialCost([{ ...base, lossPct: 0 }]).totalCents).toBe(2200);
    expect(computeMaterialCost([base]).totalCents).toBe(2200);
  });
});
