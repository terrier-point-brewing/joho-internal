import { describe, it, expect, vi, beforeEach } from "vitest";

// Isolate the backfill's decision logic from Square/the pour-consumption
// primitive: stub fetchPhysicalCounts/fetchOrderSales and the pour-aggregation
// helpers, and drive their return values per test.
vi.mock("@/lib/square/inventory", () => ({
  fetchPhysicalCounts: vi.fn(),
  fetchOrderSales: vi.fn(),
}));
vi.mock("@/lib/taproom/draftPourConsumption", () => ({
  loadDraftPourVariations: vi.fn(),
  aggregatePourFlOzByRecipe: vi.fn(),
}));

import { backfillDraftShrinkage } from "./backfillDraftShrinkage";
import { fetchOrderSales, fetchPhysicalCounts, type PhysicalCount } from "@/lib/square/inventory";
import { aggregatePourFlOzByRecipe, loadDraftPourVariations, type PourVar } from "@/lib/taproom/draftPourConsumption";

const mockFetchPhysicalCounts = vi.mocked(fetchPhysicalCounts);
const mockFetchOrderSales = vi.mocked(fetchOrderSales);
const mockLoadDraftPourVariations = vi.mocked(loadDraftPourVariations);
const mockAggregatePourFlOzByRecipe = vi.mocked(aggregatePourFlOzByRecipe);

type Row = { source_ref: string; recipe_id: string; occurred_at: string; remaining_fl_oz: number };
type Link = { recipe_id: string; square_variation_id: string | null };

// Fake supabase covering the query shapes the backfill issues: draft_swap_shrinkage
// select→order, recipe_square_links select→eq→in, and draft_swap_shrinkage
// update→eq. Captured updates land in `sink.updates`.
function fakeSupabase(rows: Row[], links: Link[], sink: { updates: { ref: string; patch: Record<string, unknown> }[] }) {
  return {
    from(table: string) {
      if (table === "recipe_square_links") {
        return { select: () => ({ eq: () => ({ in: async () => ({ data: links, error: null }) }) }) };
      }
      return {
        select: () => ({ order: async () => ({ data: rows, error: null }) }),
        update: (patch: Record<string, unknown>) => ({
          eq: async (_col: string, ref: string) => { sink.updates.push({ ref, patch }); return { error: null }; },
        }),
      };
    },
  } as never;
}

const row = (over: Partial<Row> = {}): Row => ({
  source_ref: "sqtransfer:o1:l1", recipe_id: "r1",
  occurred_at: "2026-07-04T20:00:00.000Z", remaining_fl_oz: 640, ...over,
});

const links = (): Link[] => [{ recipe_id: "r1", square_variation_id: "draft-sqvar" }];

const pourVars: PourVar[] = [{ id: "pour-5oz", oz: 5 }, { id: "pour-16oz", oz: 16 }];
const pourVarsMap = () => new Map([["r1", pourVars]]);

const physicalCount = (over: Partial<PhysicalCount> = {}): PhysicalCount => ({
  id: "c1",
  catalog_object_id: "draft-sqvar",
  catalog_object_type: "ITEM_VARIATION",
  state: "IN_STOCK",
  location_id: "loc",
  quantity: "658",
  occurred_at: "2026-07-03T10:00:00.000Z",
  created_at: "2026-07-03T10:00:00.000Z",
  ...over,
});

beforeEach(() => {
  mockFetchPhysicalCounts.mockReset();
  mockFetchOrderSales.mockReset().mockResolvedValue(new Map());
  mockLoadDraftPourVariations.mockReset().mockResolvedValue(pourVarsMap());
  mockAggregatePourFlOzByRecipe.mockReset();
});

describe("backfillDraftShrinkage", () => {
  it("reconstructs remaining as last recount minus pours since (658 - 624 = 34)", async () => {
    const sink = { updates: [] as { ref: string; patch: Record<string, unknown> }[] };
    mockFetchPhysicalCounts.mockResolvedValue([physicalCount()]);
    mockAggregatePourFlOzByRecipe.mockReturnValue(new Map([["r1", { flOz: 624, units: 100 }]]));

    const res = await backfillDraftShrinkage(
      fakeSupabase([row({ remaining_fl_oz: 640 })], links(), sink),
      { apply: false },
    );

    expect(res.mode).toBe("dry-run");
    expect(res.summary).toMatchObject({ total: 1, changed: 1, unchanged: 0, skipped: 0, errored: 0 });
    expect(res.results[0]).toMatchObject({ status: "would_update", old_remaining_fl_oz: 640, new_remaining_fl_oz: 34 });
    expect(sink.updates).toHaveLength(0);

    // Anchored on the base variation's physical counts, 60-day window ending at the swap.
    expect(mockFetchPhysicalCounts).toHaveBeenCalledWith("2026-05-05", "2026-07-04", ["draft-sqvar"]);
    // Pours queried in (recountTime, swapTime] on the pour-variation siblings.
    expect(mockFetchOrderSales).toHaveBeenCalledWith("2026-07-03T10:00:00.000Z", "2026-07-04T20:00:00.000Z", ["pour-5oz", "pour-16oz"]);
  });

  it("apply writes the recomputed value keyed on source_ref", async () => {
    const sink = { updates: [] as { ref: string; patch: Record<string, unknown> }[] };
    mockFetchPhysicalCounts.mockResolvedValue([physicalCount()]);
    mockAggregatePourFlOzByRecipe.mockReturnValue(new Map([["r1", { flOz: 624, units: 100 }]]));

    const res = await backfillDraftShrinkage(
      fakeSupabase([row({ source_ref: "ref-A", remaining_fl_oz: 640 })], links(), sink),
      { apply: true },
    );

    expect(sink.updates).toEqual([{ ref: "ref-A", patch: { remaining_fl_oz: 34 } }]);
    expect(res.summary.changed).toBe(1);
    expect(res.results[0].status).toBe("updated");
  });

  it("leaves unchanged rows alone (within epsilon)", async () => {
    const sink = { updates: [] as { ref: string; patch: Record<string, unknown> }[] };
    mockFetchPhysicalCounts.mockResolvedValue([physicalCount()]);
    mockAggregatePourFlOzByRecipe.mockReturnValue(new Map([["r1", { flOz: 624, units: 100 }]]));

    const res = await backfillDraftShrinkage(
      fakeSupabase([row({ remaining_fl_oz: 34 })], links(), sink),
      { apply: true },
    );

    expect(sink.updates).toHaveLength(0);
    expect(res.summary).toMatchObject({ changed: 0, unchanged: 1 });
    expect(res.results[0].status).toBe("unchanged");
  });

  it("skips a row whose recipe has no draft SKU link", async () => {
    const sink = { updates: [] as { ref: string; patch: Record<string, unknown> }[] };
    const res = await backfillDraftShrinkage(
      fakeSupabase([row({ recipe_id: "r-orphan" })], [], sink),
      { apply: true },
    );
    expect(mockFetchPhysicalCounts).not.toHaveBeenCalled();
    expect(res.summary).toMatchObject({ skipped: 1, changed: 0 });
    expect(res.results[0].status).toBe("skipped_no_sku");
  });

  it("skips a row whose recipe has no pour-variation siblings", async () => {
    const sink = { updates: [] as { ref: string; patch: Record<string, unknown> }[] };
    mockLoadDraftPourVariations.mockResolvedValue(new Map());

    const res = await backfillDraftShrinkage(
      fakeSupabase([row()], links(), sink),
      { apply: true },
    );

    expect(mockFetchPhysicalCounts).not.toHaveBeenCalled();
    expect(res.results[0].status).toBe("skipped_no_sku");
  });

  it("skips (does not overwrite) when no physical count precedes the swap", async () => {
    const sink = { updates: [] as { ref: string; patch: Record<string, unknown> }[] };
    mockFetchPhysicalCounts.mockResolvedValue([]);

    const res = await backfillDraftShrinkage(
      fakeSupabase([row({ remaining_fl_oz: 640 })], links(), sink),
      { apply: true },
    );

    expect(sink.updates).toHaveLength(0);
    expect(mockFetchOrderSales).not.toHaveBeenCalled();
    expect(res.summary).toMatchObject({ skipped: 1, changed: 0 });
    expect(res.results[0]).toMatchObject({ status: "skipped_no_baseline", new_remaining_fl_oz: null });
  });

  it("ignores physical counts at or after the swap time", async () => {
    const sink = { updates: [] as { ref: string; patch: Record<string, unknown> }[] };
    mockFetchPhysicalCounts.mockResolvedValue([
      physicalCount(),
      // Same-day recount rung after the swap — must not anchor the reconstruction.
      physicalCount({ id: "c2", quantity: "999", occurred_at: "2026-07-04T20:30:00.000Z", created_at: "2026-07-04T20:30:00.000Z" }),
    ]);
    mockAggregatePourFlOzByRecipe.mockReturnValue(new Map([["r1", { flOz: 624, units: 100 }]]));

    const res = await backfillDraftShrinkage(
      fakeSupabase([row({ remaining_fl_oz: 640 })], links(), sink),
      { apply: false },
    );

    expect(res.results[0]).toMatchObject({ new_remaining_fl_oz: 34 });
    expect(mockFetchOrderSales).toHaveBeenCalledWith("2026-07-03T10:00:00.000Z", "2026-07-04T20:00:00.000Z", expect.any(Array));
  });

  it("records a per-row failure as an error without aborting the run", async () => {
    const sink = { updates: [] as { ref: string; patch: Record<string, unknown> }[] };
    mockFetchPhysicalCounts
      .mockRejectedValueOnce(new Error("square 429"))
      .mockResolvedValueOnce([physicalCount()]);
    mockAggregatePourFlOzByRecipe.mockReturnValue(new Map([["r1", { flOz: 624, units: 100 }]]));

    const res = await backfillDraftShrinkage(
      fakeSupabase(
        [row({ source_ref: "ref-A", remaining_fl_oz: 640 }), row({ source_ref: "ref-B", remaining_fl_oz: 640 })],
        links(),
        sink,
      ),
      { apply: true },
    );

    expect(res.summary).toMatchObject({ total: 2, errored: 1, changed: 1 });
    expect(res.results.find((r) => r.source_ref === "ref-A")).toMatchObject({ status: "error", detail: "square 429" });
    expect(res.results.find((r) => r.source_ref === "ref-B")).toMatchObject({ status: "updated", new_remaining_fl_oz: 34 });
  });
});
