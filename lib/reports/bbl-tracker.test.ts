import { describe, it, expect } from "vitest";
import { canOzPerUnit, buildBBLTrackerReport } from "./bbl-tracker";
import { KEG_TRANSFER_DISCOUNT_NAME } from "@/types/reports";
import type { CatalogItem, Order, OrderLineItem } from "@/types/square";

const KEGS_CAT = "FXHTXXAICGRPMGJAHGJZ34MY";
const CANS_CAT = "Q5BMUOAOCBOUS4JNDRAAXA4Q";
const CB_CAT = "CDX2UMLF35B4I3F7ILYLMWMF";
const DRAFT_CAT = "567KQPEBRBZHG7ATHQFRCRWZ";

const GALLONS_PER_BBL = 31;
const STATE = 0.6171;
const FED = 3.5;
const exciseFor = (gallons: number) => gallons * STATE + (gallons / GALLONS_PER_BBL) * FED;
const bbl = (gallons: number) => gallons / GALLONS_PER_BBL;

function makeItem(opts: {
  id: string;
  name: string;
  categoryId: string;
  variations: { id: string; name: string }[];
}): CatalogItem {
  return {
    type: "ITEM",
    id: opts.id,
    item_data: {
      name: opts.name,
      product_type: "FOOD_AND_BEV",
      reporting_category: { id: opts.categoryId, ordinal: 0 },
      variations: opts.variations.map((v) => ({
        type: "ITEM_VARIATION",
        id: v.id,
        item_variation_data: { item_id: opts.id, name: v.name },
      })),
    },
  };
}

function line(opts: Partial<OrderLineItem> & { uid: string }): OrderLineItem {
  return { quantity: opts.quantity ?? "1", name: opts.name ?? "X", ...opts };
}

function order(id: string, lines: OrderLineItem[], extra: Partial<Order> = {}): Order {
  return {
    id,
    location_id: "L1",
    state: "COMPLETED",
    created_at: "2026-06-01T00:00:00Z",
    closed_at: "2026-06-01T01:00:00Z",
    line_items: lines,
    ...extra,
  };
}

// ── canOzPerUnit ───────────────────────────────────────────────────────────

describe("canOzPerUnit", () => {
  it("parses single can size", () => {
    expect(canOzPerUnit("16oz Loose")).toBe(16);
    expect(canOzPerUnit("12oz Single")).toBe(12);
  });

  it("multiplies for case (×24)", () => {
    expect(canOzPerUnit("16oz Case")).toBe(16 * 24);
  });

  it("multiplies for 12-pack (×12)", () => {
    expect(canOzPerUnit("12oz 12-Pack")).toBe(12 * 12);
    expect(canOzPerUnit("16oz 12pack")).toBe(16 * 12);
  });

  it("multiplies for 6-pack (×6) and 4-pack (×4)", () => {
    expect(canOzPerUnit("16oz 6-Pack")).toBe(16 * 6);
    expect(canOzPerUnit("16oz 4-Pack")).toBe(16 * 4);
    expect(canOzPerUnit("16oz 4pack")).toBe(16 * 4);
  });

  it("defaults to 16oz when no oz token present", () => {
    expect(canOzPerUnit("4-Pack")).toBe(16 * 4);
    expect(canOzPerUnit("Loose")).toBe(16);
  });

  it("case takes precedence over pack patterns in branch order", () => {
    // 'case' is checked first in the source
    expect(canOzPerUnit("16oz Case 4-Pack")).toBe(16 * 24);
  });
});

// ── buildBBLTrackerReport ────────────────────────────────────────────────────

describe("buildBBLTrackerReport — POS orders", () => {
  const items = [
    makeItem({ id: "k1", name: "Pale Ale (Keg)", categoryId: KEGS_CAT, variations: [{ id: "half", name: "1/2 Keg" }] }),
    makeItem({ id: "c1", name: "Pale Ale (Cans)", categoryId: CANS_CAT, variations: [{ id: "can4", name: "16oz 4-Pack" }] }),
  ];

  it("classifies a transfer keg as TAPROOM_DRAFT, regular keg as TAPROOM_PACKAGED", () => {
    const transferOrder = order("o1", [
      line({ uid: "a", catalog_object_id: "half", quantity: "1", applied_discounts: [{ uid: "ad", discount_uid: "d1" }] }),
    ], { discounts: [{ uid: "d1", name: KEG_TRANSFER_DISCOUNT_NAME }] });
    const saleOrder = order("o2", [line({ uid: "b", catalog_object_id: "half", quantity: "1" })]);

    const res = buildBBLTrackerReport([transferOrder, saleOrder], [], items);
    const row = res.byStyle.find((r) => r.style === "Pale Ale")!;
    expect(row.taproomDraftBBL).toBeCloseTo(bbl(15.5), 9);
    expect(row.taproomPkgBBL).toBeCloseTo(bbl(15.5), 9);
    expect(row.halfKegCount).toBe(2); // both count
  });

  it("counts cans as TAPROOM_PACKAGED and accumulates totalCans by cansPerUnit", () => {
    const o = order("o1", [line({ uid: "a", catalog_object_id: "can4", quantity: "3" })]);
    const res = buildBBLTrackerReport([o], [], items);
    const row = res.byStyle.find((r) => r.style === "Pale Ale")!;
    // 16oz 4-pack = 64 oz/unit × 3 = 192 oz = 1.5 gal
    expect(row.totalCans).toBe(12); // 4 cans × 3
    expect(row.taproomPkgBBL).toBeCloseTo(bbl(192 / 128), 9);
  });

  it("computes excise tax from total gallons", () => {
    const o = order("o1", [line({ uid: "a", catalog_object_id: "half", quantity: "2" })]);
    const res = buildBBLTrackerReport([o], [], items);
    const row = res.byStyle.find((r) => r.style === "Pale Ale")!;
    const gallons = 15.5 * 2;
    expect(row.totalGallons).toBeCloseTo(gallons, 9);
    expect(row.exciseTax).toBeCloseTo(exciseFor(gallons), 9);
    expect(res.totalExciseTax).toBeCloseTo(exciseFor(gallons), 9);
  });

  it("defaults quantity to 1 when missing", () => {
    const o = order("o1", [line({ uid: "a", catalog_object_id: "half" })]);
    const res = buildBBLTrackerReport([o], [], items);
    expect(res.byStyle.find((r) => r.style === "Pale Ale")!.halfKegCount).toBe(1);
  });
});

describe("buildBBLTrackerReport — invoice channel classification", () => {
  const items = [
    makeItem({ id: "k1", name: "Pale Ale (Keg)", categoryId: KEGS_CAT, variations: [{ id: "half", name: "1/2 Keg" }] }),
    makeItem({ id: "cb1", name: "Packaging Fee", categoryId: CB_CAT, variations: [{ id: "cbvar", name: "Service" }] }),
  ];

  it("routes invoice keg to DISTRIBUTION when no contract-brewing item present", () => {
    const o = order("o1", [line({ uid: "a", catalog_object_id: "half", quantity: "1" })], { state: "OPEN" });
    const res = buildBBLTrackerReport([], [o], items);
    const row = res.byStyle.find((r) => r.style === "Pale Ale")!;
    expect(row.distBBL).toBeCloseTo(bbl(15.5), 9);
    expect(row.contractBBL).toBe(0);
  });

  it("routes invoice keg to CONTRACT_BREWING when any CB item present on the order", () => {
    const o = order("o1", [
      line({ uid: "a", catalog_object_id: "half", quantity: "1" }),
      line({ uid: "b", catalog_object_id: "cbvar", quantity: "1" }),
    ], { state: "OPEN" });
    const res = buildBBLTrackerReport([], [o], items);
    const row = res.byStyle.find((r) => r.style === "Pale Ale")!;
    expect(row.contractBBL).toBeCloseTo(bbl(15.5), 9);
    expect(row.distBBL).toBe(0);
  });
});

describe("buildBBLTrackerReport — Packaging Fee keg via line.note", () => {
  const items = [
    makeItem({ id: "draft1", name: "Citra Haze", categoryId: DRAFT_CAT, variations: [{ id: "dv", name: "Pint" }] }),
    makeItem({ id: "cb1", name: "Packaging Fee", categoryId: CB_CAT, variations: [
      { id: "pfhalf", name: "1/2 Keg" },
      { id: "pfcan", name: "16oz 4-Pack" },
    ] }),
  ];

  it("attributes packaging-fee keg volume to the beer style resolved from line.note", () => {
    const o = order("o1", [
      line({ uid: "a", catalog_object_id: "pfhalf", quantity: "1", note: "Citra Haze" }),
    ], { state: "OPEN" });
    const res = buildBBLTrackerReport([], [o], items);
    const row = res.byStyle.find((r) => r.style === "Citra Haze")!;
    expect(row.contractBBL).toBeCloseTo(bbl(15.5), 9); // CB item present → contract channel
    expect(row.halfKegCount).toBe(1);
  });

  it("attributes packaging-fee can volume and cans via line.note", () => {
    const o = order("o1", [
      line({ uid: "a", catalog_object_id: "pfcan", quantity: "2", note: "Citra Haze" }),
    ], { state: "OPEN" });
    const res = buildBBLTrackerReport([], [o], items);
    const row = res.byStyle.find((r) => r.style === "Citra Haze")!;
    // 16oz 4-pack = 64 oz × 2 = 128 oz = 1 gal
    expect(row.contractBBL).toBeCloseTo(bbl(1), 9);
    expect(row.totalCans).toBe(8); // 4 cans × 2
  });

  it("falls back to trimmed note text when no draft style matches", () => {
    const o = order("o1", [
      line({ uid: "a", catalog_object_id: "pfhalf", quantity: "1", note: "  Mystery Beer  " }),
    ], { state: "OPEN" });
    const res = buildBBLTrackerReport([], [o], items);
    expect(res.byStyle.some((r) => r.style === "Mystery Beer")).toBe(true);
  });

  it("skips packaging-fee keg with no note (no beer style resolved)", () => {
    const o = order("o1", [line({ uid: "a", catalog_object_id: "pfhalf", quantity: "1" })], { state: "OPEN" });
    const res = buildBBLTrackerReport([], [o], items);
    expect(res.byStyle).toEqual([]);
  });
});

describe("buildBBLTrackerReport — assembly, sorting, filtering", () => {
  const items = [
    makeItem({ id: "k1", name: "Big Seller (Keg)", categoryId: KEGS_CAT, variations: [{ id: "bighalf", name: "1/2 Keg" }] }),
    makeItem({ id: "k2", name: "Small Seller (Keg)", categoryId: KEGS_CAT, variations: [{ id: "smallsixth", name: "1/6 Keg" }] }),
  ];

  it("sorts byStyle by totalBBL descending and filters out zero-volume styles", () => {
    const o = order("o1", [
      line({ uid: "a", catalog_object_id: "bighalf", quantity: "1" }),
      line({ uid: "b", catalog_object_id: "smallsixth", quantity: "1" }),
    ]);
    const res = buildBBLTrackerReport([o], [], items);
    expect(res.byStyle.map((r) => r.style)).toEqual(["Big Seller", "Small Seller"]);
  });

  it("byChannel filters channels with zero gallons", () => {
    const o = order("o1", [line({ uid: "a", catalog_object_id: "bighalf", quantity: "1" })]);
    const res = buildBBLTrackerReport([o], [], items);
    expect(res.byChannel.map((c) => c.channel)).toEqual(["Taproom Packaged"]);
    expect(res.byChannel[0].gallons).toBeCloseTo(15.5, 9);
    expect(res.byChannel[0].bbl).toBeCloseTo(bbl(15.5), 9);
  });

  it("returns empty results for empty input", () => {
    const res = buildBBLTrackerReport([], [], []);
    expect(res.byStyle).toEqual([]);
    expect(res.byChannel).toEqual([]);
    expect(res.totalExciseTax).toBe(0);
  });
});
