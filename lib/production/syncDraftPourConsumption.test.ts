import { it, expect, vi, beforeEach } from "vitest";
vi.mock("@/lib/square/inventory", () => ({ fetchOrderSalesByDay: vi.fn() }));
vi.mock("@/lib/taproom/draftPourConsumption", async (orig) => ({
  ...(await orig<typeof import("@/lib/taproom/draftPourConsumption")>()),
  loadDraftPourVariations: vi.fn(),
}));
import { syncDraftPourConsumption } from "./syncDraftPourConsumption";
import { fetchOrderSalesByDay } from "@/lib/square/inventory";
import { loadDraftPourVariations } from "@/lib/taproom/draftPourConsumption";

const sales = vi.mocked(fetchOrderSalesByDay);
const loadVars = vi.mocked(loadDraftPourVariations);

function fakeDb(sink: { upserts: unknown[] }) {
  return { from: () => ({ upsert: async (rows: unknown) => { sink.upserts.push(rows); return { error: null }; } }) } as never;
}

beforeEach(() => { sales.mockReset(); loadVars.mockReset(); });

it("upserts per-recipe-day pour fl oz from Square sales", async () => {
  loadVars.mockResolvedValue(new Map([["r1", [{ id: "v16", oz: 16 }]]]));
  sales.mockResolvedValue(new Map([["v16\t2026-07-01", 2]]));
  const sink = { upserts: [] as unknown[] };
  const res = await syncDraftPourConsumption(fakeDb(sink), { days: 30 });
  expect(sink.upserts[0]).toEqual([{ recipe_id: "r1", business_date: "2026-07-01", fl_oz: 32, pour_units: 2 }]);
  expect(res).toEqual({ recipesTouched: 1, rowsUpserted: 1 });
});

it("no-ops when there are no draft pour variations", async () => {
  loadVars.mockResolvedValue(new Map());
  const sink = { upserts: [] as unknown[] };
  const res = await syncDraftPourConsumption(fakeDb(sink), { days: 30 });
  expect(sales).not.toHaveBeenCalled();
  expect(res).toEqual({ recipesTouched: 0, rowsUpserted: 0 });
});
