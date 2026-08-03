import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/square/inventory", () => ({
  fetchCurrentCounts: vi.fn(),
  setPhysicalCount: vi.fn(),
}));
vi.mock("@/lib/square/skuMappings", () => ({
  resolveProductSku: vi.fn(),
}));

import {
  planCanReconciliation,
  variantStem,
  pickBaseVariation,
  reconcileSquareCanInventory,
  type ReconcileFamilyInput,
  type ItemVariation,
} from "./reconcileSquareCanInventory";
import { fetchCurrentCounts, setPhysicalCount } from "@/lib/square/inventory";
import { resolveProductSku } from "@/lib/square/skuMappings";

const fetchCounts = vi.mocked(fetchCurrentCounts);
const recount = vi.mocked(setPhysicalCount);
const resolveSku = vi.mocked(resolveProductSku);

const fam = (over: Partial<ReconcileFamilyInput> = {}): ReconcileFamilyInput => ({
  recipeId: "r1",
  baseSquareVariationId: "SQ-LOOSE",
  baseVariationName: "16oz Labeled Can",
  cansEachByVar: { loose: 1, pack: 4, case: 24 },
  onHandByVar: { loose: 8, pack: 0, case: 1 }, // 8 + 24 = 32 loose-equiv
  ...over,
});

describe("planCanReconciliation", () => {
  it("writes cold-storage total onto the base variation when Square drifts", () => {
    const plan = planCanReconciliation({ families: [fam()], squareCountByVar: { "SQ-LOOSE": 61 } });
    expect(plan.writes).toEqual([
      { recipeId: "r1", baseSquareVariationId: "SQ-LOOSE", baseVariationName: "16oz Labeled Can", coldStorageCans: 32, squareCansBefore: 61, drift: 29 },
    ]);
  });

  it("no write when Square already matches within threshold", () => {
    const plan = planCanReconciliation({ families: [fam()], squareCountByVar: { "SQ-LOOSE": 32 } });
    expect(plan.writes).toEqual([]);
  });

  it("skips a family whose loose tier has no Square link", () => {
    const plan = planCanReconciliation({ families: [fam({ baseSquareVariationId: null })], squareCountByVar: {} });
    expect(plan.writes).toEqual([]);
    expect(plan.skips[0].reason).toMatch(/no base/i);
  });

  it("rounds a fractional loose-equivalent and warns", () => {
    const plan = planCanReconciliation({
      families: [fam({ onHandByVar: { loose: 0.6, pack: 0, case: 0 } })],
      squareCountByVar: { "SQ-LOOSE": 5 },
    });
    expect(plan.writes[0].coldStorageCans).toBe(1); // round(0.6)
    expect(plan.warnings.join()).toMatch(/fractional/i);
  });
});

const iv = (over: Partial<ItemVariation>): ItemVariation =>
  ({ squareVariationId: "sq", variationName: "Regular", volumeFlOzPerUnit: null, trackInventory: true, ...over });

describe("variantStem", () => {
  it("strips the size/format suffix", () => {
    expect(variantStem("Regular - 16oz Case")).toBe("Regular");
    expect(variantStem("Be Like Mike - 16oz 4-Pack")).toBe("Be Like Mike");
    expect(variantStem("Regular")).toBe("Regular");
  });
});

describe("pickBaseVariation", () => {
  it("returns the single tracked parent (volume null)", () => {
    const base = pickBaseVariation({
      itemVariations: [
        iv({ squareVariationId: "REG", variationName: "Regular" }),
        iv({ squareVariationId: "REG-CASE", variationName: "Regular - 16oz Case", volumeFlOzPerUnit: 384 }),
      ],
      stem: "Regular",
    });
    expect(base?.squareVariationId).toBe("REG");
  });

  it("disambiguates Regular vs Be Like Mike parents by stem", () => {
    const vars = [
      iv({ squareVariationId: "REG", variationName: "Regular" }),
      iv({ squareVariationId: "BLM", variationName: "Be Like Mike", trackInventory: false }),
    ];
    expect(pickBaseVariation({ itemVariations: vars, stem: "Regular" })?.squareVariationId).toBe("REG");
  });

  it("returns null when the matching parent is not inventory-tracked (Be Like Mike)", () => {
    const vars = [iv({ squareVariationId: "BLM", variationName: "Be Like Mike", trackInventory: false })];
    expect(pickBaseVariation({ itemVariations: vars, stem: "Be Like Mike" })).toBeNull();
  });

  it("returns null when ambiguous (multiple tracked parents, no stem match)", () => {
    const vars = [iv({ squareVariationId: "A", variationName: "Alpha" }), iv({ squareVariationId: "B", variationName: "Beta" })];
    expect(pickBaseVariation({ itemVariations: vars, stem: "Gamma" })).toBeNull();
  });
});

// ── reconcileSquareCanInventory (IO orchestrator) ────────────────────────────
//
// Fakes just enough of the supabase client shape the reconciler touches:
// cold_storage_inventory (select + optional .in scoping), square_catalog_variations
// (select + .eq by item id), and square_inventory_reconciliations (insert, captured
// into `sink`). @/lib/square/inventory and @/lib/square/skuMappings are module-mocked
// above so no real Square calls happen.

interface PackagingVariationRow {
  id: string;
  format: string;
  total_volume_fl_oz: number;
  container_id: string;
  lid_id: string | null;
  label_id: string | null;
  partner_id: string | null;
}

const packagingRow = (over: Partial<PackagingVariationRow> = {}): PackagingVariationRow => ({
  id: "PV", format: "loose", total_volume_fl_oz: 16,
  container_id: "CAN-16", lid_id: null, label_id: null, partner_id: null,
  ...over,
});

const csRow = (recipeId: string, variationId: string, qty: number, pv: PackagingVariationRow) => ({
  recipe_id: recipeId,
  variation_id: variationId,
  quantity_on_hand: qty,
  packaging_variations: { ...pv, packaging_items: { type: "can" } },
});

interface CatalogVarRow {
  square_variation_id: string;
  variation_name: string;
  volume_fl_oz_per_unit: number | null;
  track_inventory: boolean;
  /** Mirror rows for variations Square has deleted; omitted means live. */
  is_deleted?: boolean;
}

function fakeSupabase(opts: {
  coldStorageRows: ReturnType<typeof csRow>[];
  catalogVariationsByItem: Record<string, CatalogVarRow[]>;
  sink?: { reconciliations: unknown[] };
}) {
  return {
    from: (table: string) => {
      if (table === "cold_storage_inventory") {
        return {
          select: () => ({
            data: opts.coldStorageRows,
            error: null,
            in: (_col: string, ids: string[]) => ({
              data: opts.coldStorageRows.filter((r) => ids.includes(r.recipe_id)),
              error: null,
            }),
          }),
        };
      }
      if (table === "square_catalog_variations") {
        // Chainable .eq() — the reconciler filters on square_item_id AND
        // is_deleted, so a single-.eq() stub would not exercise the real query.
        // Rows carrying `is_deleted: true` are filtered out here exactly as
        // PostgREST would, which is what pins the ghost-exclusion behaviour.
        const build = (rows: CatalogVarRow[]) => ({
          data: rows,
          error: null,
          eq: (col: string, val: unknown) =>
            build(
              col === "square_item_id"
                ? (opts.catalogVariationsByItem[val as string] ?? [])
                : rows.filter((r) => (r[col as keyof CatalogVarRow] ?? false) === val),
            ),
        });
        return { select: () => build([]) };
      }
      if (table === "square_inventory_reconciliations") {
        return {
          insert: async (row: unknown) => {
            opts.sink?.reconciliations.push(row);
            return { error: null };
          },
        };
      }
      throw new Error(`fakeSupabase: unexpected table ${table}`);
    },
  } as never;
}

describe("reconcileSquareCanInventory (IO)", () => {
  beforeEach(() => {
    fetchCounts.mockReset();
    recount.mockReset();
    resolveSku.mockReset();
  });

  // Regular can family: loose (16oz) < 4-pack (64oz) < case (384oz), all sharing
  // one Square item "ITEM-1" whose tracked parent variation is "SQ-BASE".
  const loosePv = packagingRow({ id: "PV-LOOSE", format: "loose", total_volume_fl_oz: 16 });
  const packPv = packagingRow({ id: "PV-PACK", format: "4-pack", total_volume_fl_oz: 64 });
  const casePv = packagingRow({ id: "PV-CASE", format: "case", total_volume_fl_oz: 384 });

  const baseItemVars: CatalogVarRow[] = [
    { square_variation_id: "SQ-BASE", variation_name: "Regular", volume_fl_oz_per_unit: null, track_inventory: true },
    { square_variation_id: "SQ-PACK-SALE", variation_name: "Regular - 4-Pack", volume_fl_oz_per_unit: 64, track_inventory: true },
    { square_variation_id: "SQ-CASE-SALE", variation_name: "Regular - Case", volume_fl_oz_per_unit: 384, track_inventory: true },
  ];

  // The loose tier's OWN recipe_square_links row is (deliberately, per the audited
  // bug) mis-mapped to the 4-pack sale variation. Base resolution must still land
  // on the item's tracked parent (SQ-BASE) via the item id, never on this link.
  function mockRegularFamilySkus() {
    resolveSku.mockImplementation(async (_db, args) => {
      if (args.kind !== "packaged") return null;
      if (args.variationId === "PV-LOOSE") {
        return { squareVariationId: "SQ-PACK-SALE", squareItemId: "ITEM-1", catalogVariationId: null, itemName: "Regular", variationName: "Regular - 4-Pack" };
      }
      if (args.variationId === "PV-PACK") {
        return { squareVariationId: "SQ-PACK-SALE", squareItemId: "ITEM-1", catalogVariationId: null, itemName: "Regular", variationName: "Regular - 4-Pack" };
      }
      if (args.variationId === "PV-CASE") {
        return { squareVariationId: "SQ-CASE-SALE", squareItemId: "ITEM-1", catalogVariationId: null, itemName: "Regular", variationName: "Regular - Case" };
      }
      return null;
    });
  }

  it("plans the loose-equivalent correction but does NOT push it to Square (observe-only)", async () => {
    mockRegularFamilySkus();
    fetchCounts.mockResolvedValue(new Map([["SQ-BASE", 40]]));
    recount.mockResolvedValue(undefined);
    const sink = { reconciliations: [] as unknown[] };

    const supabase = fakeSupabase({
      coldStorageRows: [
        csRow("r1", "PV-LOOSE", 8, loosePv),
        csRow("r1", "PV-PACK", 0, packPv),
        csRow("r1", "PV-CASE", 1, casePv),
      ],
      catalogVariationsByItem: { "ITEM-1": baseItemVars },
      sink,
    });

    // 8 loose + 0 packs*4 + 1 case*24 = 32 loose-equivalent; Square was at 40.
    const res = await reconcileSquareCanInventory(supabase, { recipeIds: ["r1"], occurredAt: "2026-07-08T12:00:00Z" });

    // The drift is fully measured and reported...
    expect(res.writes).toEqual([
      expect.objectContaining({
        recipeId: "r1",
        baseSquareVariationId: "SQ-BASE",
        coldStorageCans: 32,
        squareCansBefore: 40,
        drift: 8,
      }),
    ]);

    // ...but nothing is written to Square, and nothing is journalled as applied,
    // while the push is off. A journal row means "we changed Square"; recording
    // one for a write we never sent is exactly the lie that hid the stale-link
    // bug for nine days.
    expect(recount).not.toHaveBeenCalled();
    expect(sink.reconciliations).toEqual([]);
    expect(res.applied).toBe(0);
  });

  it("skips a family whose item's matching parent is not inventory-tracked (Be Like Mike)", async () => {
    resolveSku.mockImplementation(async (_db, args) => {
      if (args.kind === "packaged" && args.variationId === "PV-BLM-LOOSE") {
        return { squareVariationId: "SQ-BLM-LOOSE", squareItemId: "ITEM-2", catalogVariationId: null, itemName: "Be Like Mike", variationName: "Be Like Mike" };
      }
      return null;
    });
    fetchCounts.mockResolvedValue(new Map());
    const sink = { reconciliations: [] as unknown[] };

    const blmPv = packagingRow({ id: "PV-BLM-LOOSE", format: "loose", total_volume_fl_oz: 16, label_id: "LBL-BLM" });
    const supabase = fakeSupabase({
      coldStorageRows: [csRow("r2", "PV-BLM-LOOSE", 5, blmPv)],
      catalogVariationsByItem: {
        "ITEM-2": [{ square_variation_id: "SQ-BLM-LOOSE", variation_name: "Be Like Mike", volume_fl_oz_per_unit: null, track_inventory: false }],
      },
      sink,
    });

    const res = await reconcileSquareCanInventory(supabase, { recipeIds: ["r2"] });

    expect(recount).not.toHaveBeenCalled();
    expect(res.applied).toBe(0);
    expect(res.skips.some((s) => s.recipeId === "r2" && s.reason.includes("Be Like Mike"))).toBe(true);
    expect(sink.reconciliations).toHaveLength(0);
  });

  // The regression that started all of this: the mapped variation had been
  // deleted in Square, so the count read came back empty. Coercing that to 0
  // produced a -158 "drift" against a SKU that did not exist, and the reconciler
  // chased it 1,040 times without ever converging. No count is not a count.
  it("treats a variation Square returns no count for as unknown, never as zero", async () => {
    mockRegularFamilySkus();
    fetchCounts.mockResolvedValue(new Map()); // Square answered, but not about SQ-BASE
    const sink = { reconciliations: [] as unknown[] };

    const supabase = fakeSupabase({
      coldStorageRows: [
        csRow("r1", "PV-LOOSE", 8, loosePv),
        csRow("r1", "PV-PACK", 0, packPv),
        csRow("r1", "PV-CASE", 1, casePv),
      ],
      catalogVariationsByItem: { "ITEM-1": baseItemVars },
      sink,
    });

    const res = await reconcileSquareCanInventory(supabase, { recipeIds: ["r1"] });

    expect(res.writes).toEqual([]);
    expect(res.applied).toBe(0);
    expect(recount).not.toHaveBeenCalled();
    expect(sink.reconciliations).toEqual([]);
    expect(res.skips.some((s) => s.recipeId === "r1" && /unknown, not zero/.test(s.reason))).toBe(true);
  });

  // Deleted variations stay in the mirror so their mappings remain inspectable,
  // but they must not compete to be the family's base. Wiggo! IPA's item really
  // does carry three deleted rows next to its live ones.
  it("ignores mirror rows for variations Square has deleted when picking the base", async () => {
    mockRegularFamilySkus();
    fetchCounts.mockResolvedValue(new Map([["SQ-BASE", 40]]));
    const sink = { reconciliations: [] as unknown[] };

    const supabase = fakeSupabase({
      coldStorageRows: [
        csRow("r1", "PV-LOOSE", 8, loosePv),
        csRow("r1", "PV-PACK", 0, packPv),
        csRow("r1", "PV-CASE", 1, casePv),
      ],
      catalogVariationsByItem: {
        "ITEM-1": [
          // A second untracked-parent ghost would make base resolution ambiguous
          // and silently skip the whole family if it were still considered.
          { square_variation_id: "SQ-DEAD-BASE", variation_name: "Regular", volume_fl_oz_per_unit: null, track_inventory: true, is_deleted: true },
          ...baseItemVars,
        ],
      },
      sink,
    });

    const res = await reconcileSquareCanInventory(supabase, { recipeIds: ["r1"], occurredAt: "2026-08-03T12:00:00Z" });

    expect(res.writes).toEqual([
      expect.objectContaining({ baseSquareVariationId: "SQ-BASE", coldStorageCans: 32, squareCansBefore: 40 }),
    ]);
    expect(res.skips).toEqual([]);
  });

  it("does not write when Square's count already matches cold storage's loose-equivalent", async () => {
    mockRegularFamilySkus();
    fetchCounts.mockResolvedValue(new Map([["SQ-BASE", 32]]));
    const sink = { reconciliations: [] as unknown[] };

    const supabase = fakeSupabase({
      coldStorageRows: [
        csRow("r1", "PV-LOOSE", 8, loosePv),
        csRow("r1", "PV-PACK", 0, packPv),
        csRow("r1", "PV-CASE", 1, casePv),
      ],
      catalogVariationsByItem: { "ITEM-1": baseItemVars },
      sink,
    });

    const res = await reconcileSquareCanInventory(supabase, { recipeIds: ["r1"] });

    expect(recount).not.toHaveBeenCalled();
    expect(res.applied).toBe(0);
    expect(sink.reconciliations).toHaveLength(0);
  });
});
