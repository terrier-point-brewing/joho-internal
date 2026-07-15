import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { requireRole } from "@/lib/auth";

vi.mock("@/lib/auth", () => ({
  requireRole: vi.fn().mockResolvedValue(undefined),
}));

interface Recorded { table: string; op: "insert" | "update"; payload: unknown; eqId?: string }
let recorded: Recorded[] = [];
let rpcCalls: { name: string; args: unknown }[] = [];

const INGREDIENTS = [
  { id: "ing-1", stock_quantity: 100, cost_per_unit: 2.0, unit: "lb" },
  { id: "ing-2", stock_quantity: 50, cost_per_unit: 1.0, unit: "oz" },
];

function makeChain(table: string) {
  return {
    select: () => ({
      in: () => Promise.resolve({ data: INGREDIENTS, error: null }),
    }),
    insert: (payload: unknown) => {
      recorded.push({ table, op: "insert", payload });
      return Promise.resolve({ error: null });
    },
    update: (payload: unknown) => ({
      eq: (_field: string, id: string) => {
        recorded.push({ table, op: "update", payload, eqId: id });
        return Promise.resolve({ error: null });
      },
    }),
  };
}

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: vi.fn(async () => ({
    from: (table: string) => makeChain(table),
    rpc: (name: string, args: unknown) => {
      rpcCalls.push({ name, args });
      return Promise.resolve({ error: null });
    },
  })),
}));

function req(body: unknown) {
  return new NextRequest("http://localhost/api/production/stock-adjustments/bulk", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("POST /api/production/stock-adjustments/bulk", () => {
  beforeEach(() => {
    recorded = [];
    rpcCalls = [];
    vi.mocked(requireRole).mockResolvedValue(undefined as never);
  });

  it("rejects an empty lines array", async () => {
    const { POST } = await import("./route");
    const res = await POST(req({ lines: [], freight_total: 0 }));
    expect(res.status).toBe(400);
  });

  it("rejects duplicate ingredient_id across lines", async () => {
    const { POST } = await import("./route");
    const res = await POST(req({
      lines: [
        { ingredient_id: "ing-1", quantity: 10, purchase_cost: 1 },
        { ingredient_id: "ing-1", quantity: 5, purchase_cost: 1 },
      ],
      freight_total: 0,
    }));
    expect(res.status).toBe(400);
  });

  it("rejects a non-positive quantity", async () => {
    const { POST } = await import("./route");
    const res = await POST(req({
      lines: [{ ingredient_id: "ing-1", quantity: 0, purchase_cost: 1 }],
      freight_total: 0,
    }));
    expect(res.status).toBe(400);
  });

  it("rejects a negative freight_total", async () => {
    const { POST } = await import("./route");
    const res = await POST(req({
      lines: [{ ingredient_id: "ing-1", quantity: 10, purchase_cost: 1 }],
      freight_total: -1,
    }));
    expect(res.status).toBe(400);
  });

  it("returns whatever requireRole throws (role gate)", async () => {
    vi.mocked(requireRole).mockRejectedValueOnce(new Response(null, { status: 403 }) as never);
    const { POST } = await import("./route");
    const res = await POST(req({ lines: [], freight_total: 0 }));
    expect(res.status).toBe(403);
  });

  it("allocates freight by weight and writes each line through the shared calc", async () => {
    const { POST } = await import("./route");
    const res = await POST(req({
      lines: [
        { ingredient_id: "ing-1", quantity: 10, purchase_cost: 2.5 }, // lb: weight 160
        { ingredient_id: "ing-2", quantity: 16, purchase_cost: 1.0 }, // oz: weight 16
      ],
      freight_total: 17.6,
    }));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.errors).toEqual([]);
    expect(json.results).toHaveLength(2);

    const adjInserts = recorded.filter((r) => r.table === "stock_adjustments" && r.op === "insert");
    expect((adjInserts[0].payload as { shipping_cost: number }).shipping_cost).toBe(16);
    expect((adjInserts[1].payload as { shipping_cost: number }).shipping_cost).toBe(1.6);

    expect(rpcCalls).toEqual([
      { name: "adjust_ingredient_stock", args: { p_id: "ing-1", p_delta: 10 } },
      { name: "adjust_ingredient_stock", args: { p_id: "ing-2", p_delta: 16 } },
    ]);
  });
});
