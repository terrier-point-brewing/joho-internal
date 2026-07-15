import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { requireRole } from "@/lib/auth";

vi.mock("@/lib/auth", () => ({
  requireRole: vi.fn().mockResolvedValue(undefined),
}));

interface Recorded { table: string; op: "insert" | "update"; payload: unknown; eqId?: string }
let recorded: Recorded[] = [];

const PACKAGING_ITEMS = [
  { id: "pkg-1", stock_quantity: 200, unit_cost: 0.1 },
  { id: "pkg-2", stock_quantity: 500, unit_cost: 0.05 },
];

function makeChain(table: string) {
  return {
    select: () => ({
      in: () => Promise.resolve({ data: PACKAGING_ITEMS, error: null }),
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
  })),
}));

function req(body: unknown) {
  return new NextRequest("http://localhost/api/production/packaging-adjustments/bulk", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("POST /api/production/packaging-adjustments/bulk", () => {
  beforeEach(() => {
    recorded = [];
    vi.mocked(requireRole).mockResolvedValue(undefined as never);
  });

  it("rejects an empty lines array", async () => {
    const { POST } = await import("./route");
    const res = await POST(req({ lines: [], freight_total: 0 }));
    expect(res.status).toBe(400);
  });

  it("rejects duplicate packaging_item_id across lines", async () => {
    const { POST } = await import("./route");
    const res = await POST(req({
      lines: [
        { packaging_item_id: "pkg-1", quantity: 10, purchase_cost: 1 },
        { packaging_item_id: "pkg-1", quantity: 5, purchase_cost: 1 },
      ],
      freight_total: 0,
    }));
    expect(res.status).toBe(400);
  });

  it("rejects a non-positive quantity", async () => {
    const { POST } = await import("./route");
    const res = await POST(req({
      lines: [{ packaging_item_id: "pkg-1", quantity: 0, purchase_cost: 1 }],
      freight_total: 0,
    }));
    expect(res.status).toBe(400);
  });

  it("returns whatever requireRole throws (role gate)", async () => {
    vi.mocked(requireRole).mockRejectedValueOnce(new Response(null, { status: 403 }) as never);
    const { POST } = await import("./route");
    const res = await POST(req({ lines: [], freight_total: 0 }));
    expect(res.status).toBe(403);
  });

  it("splits freight by raw quantity (no unit column on packaging_items)", async () => {
    const { POST } = await import("./route");
    const res = await POST(req({
      lines: [
        { packaging_item_id: "pkg-1", quantity: 100, purchase_cost: 0.1 },
        { packaging_item_id: "pkg-2", quantity: 300, purchase_cost: 0.05 },
      ],
      freight_total: 40,
    }));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.errors).toEqual([]);

    const adjInserts = recorded.filter((r) => r.table === "packaging_stock_adjustments" && r.op === "insert");
    // 100:300 quantity split of $40 -> $10.00 / $30.00
    expect((adjInserts[0].payload as { shipping_cost: number }).shipping_cost).toBe(10);
    expect((adjInserts[1].payload as { shipping_cost: number }).shipping_cost).toBe(30);
  });
});
