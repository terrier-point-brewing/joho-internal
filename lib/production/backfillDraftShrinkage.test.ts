import { describe, it, expect, vi, beforeEach } from "vitest";

// Isolate the backfill's decision logic from Square: stub the shared
// reconstruction helper and drive its return per (variationId, occurredAt).
vi.mock("./taproomConsumptionSync", async (orig) => ({
  ...(await orig<typeof import("./taproomConsumptionSync")>()),
  reconstructRemainingFlOz: vi.fn(),
}));

import { backfillDraftShrinkage } from "./backfillDraftShrinkage";
import { reconstructRemainingFlOz } from "./taproomConsumptionSync";

const reconstruct = vi.mocked(reconstructRemainingFlOz);

type Row = { source_ref: string; recipe_id: string; occurred_at: string; remaining_fl_oz: number };
type Link = { recipe_id: string; square_variation_id: string | null };

// Fake supabase covering the three query shapes the backfill issues:
// draft_swap_shrinkage select→order, recipe_square_links select→eq→in, and
// draft_swap_shrinkage update→eq. Captured updates land in `sink.updates`.
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
  occurred_at: "2026-07-04T20:00:00Z", remaining_fl_oz: 640, ...over,
});

beforeEach(() => reconstruct.mockReset());

describe("backfillDraftShrinkage", () => {
  it("dry-run reports would_update without writing", async () => {
    const sink = { updates: [] as { ref: string; patch: Record<string, unknown> }[] };
    reconstruct.mockResolvedValue(45);
    const res = await backfillDraftShrinkage(
      fakeSupabase([row({ remaining_fl_oz: 640 })], [{ recipe_id: "r1", square_variation_id: "draft-sqvar" }], sink),
      { apply: false },
    );
    expect(sink.updates).toHaveLength(0);
    expect(res.mode).toBe("dry-run");
    expect(res.summary).toMatchObject({ total: 1, changed: 1, unchanged: 0, skipped: 0, errored: 0 });
    expect(res.results[0]).toMatchObject({ status: "would_update", old_remaining_fl_oz: 640, new_remaining_fl_oz: 45 });
    // Reconstruction is driven by the re-derived draft SKU + the row's timestamp.
    expect(reconstruct).toHaveBeenCalledWith("draft-sqvar", "2026-07-04T20:00:00Z");
  });

  it("apply writes the recomputed value keyed on source_ref", async () => {
    const sink = { updates: [] as { ref: string; patch: Record<string, unknown> }[] };
    reconstruct.mockResolvedValue(45);
    const res = await backfillDraftShrinkage(
      fakeSupabase([row({ source_ref: "ref-A", remaining_fl_oz: 640 })], [{ recipe_id: "r1", square_variation_id: "draft-sqvar" }], sink),
      { apply: true },
    );
    expect(sink.updates).toEqual([{ ref: "ref-A", patch: { remaining_fl_oz: 45 } }]);
    expect(res.summary.changed).toBe(1);
    expect(res.results[0].status).toBe("updated");
  });

  it("leaves unchanged rows alone (within epsilon)", async () => {
    const sink = { updates: [] as { ref: string; patch: Record<string, unknown> }[] };
    reconstruct.mockResolvedValue(45);
    const res = await backfillDraftShrinkage(
      fakeSupabase([row({ remaining_fl_oz: 45 })], [{ recipe_id: "r1", square_variation_id: "draft-sqvar" }], sink),
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
    expect(reconstruct).not.toHaveBeenCalled();
    expect(res.summary).toMatchObject({ skipped: 1, changed: 0 });
    expect(res.results[0].status).toBe("skipped_no_sku");
  });

  it("skips (does not overwrite) when the ledger has no anchoring physical count", async () => {
    const sink = { updates: [] as { ref: string; patch: Record<string, unknown> }[] };
    reconstruct.mockResolvedValue(null);
    const res = await backfillDraftShrinkage(
      fakeSupabase([row({ remaining_fl_oz: 640 })], [{ recipe_id: "r1", square_variation_id: "draft-sqvar" }], sink),
      { apply: true },
    );
    expect(sink.updates).toHaveLength(0);
    expect(res.summary).toMatchObject({ skipped: 1, changed: 0 });
    expect(res.results[0]).toMatchObject({ status: "skipped_no_baseline", new_remaining_fl_oz: null });
  });

  it("records a reconstruction failure as an error without aborting the run", async () => {
    const sink = { updates: [] as { ref: string; patch: Record<string, unknown> }[] };
    reconstruct
      .mockRejectedValueOnce(new Error("square 429"))
      .mockResolvedValueOnce(45);
    const res = await backfillDraftShrinkage(
      fakeSupabase(
        [row({ source_ref: "ref-A", remaining_fl_oz: 640 }), row({ source_ref: "ref-B", remaining_fl_oz: 640 })],
        [{ recipe_id: "r1", square_variation_id: "draft-sqvar" }],
        sink,
      ),
      { apply: true },
    );
    expect(res.summary).toMatchObject({ total: 2, errored: 1, changed: 1 });
    expect(res.results.find((r) => r.source_ref === "ref-A")).toMatchObject({ status: "error", detail: "square 429" });
    expect(res.results.find((r) => r.source_ref === "ref-B")).toMatchObject({ status: "updated", new_remaining_fl_oz: 45 });
  });
});
