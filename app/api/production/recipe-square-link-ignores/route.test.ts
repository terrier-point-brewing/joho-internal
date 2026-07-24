import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({
  requireRole: vi.fn().mockResolvedValue(undefined),
}));

const upsertCalls: unknown[] = [];

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: vi.fn(async () => ({
    from: vi.fn(() => {
      const chain = {
        upsert: vi.fn((row: unknown) => { upsertCalls.push(row); return chain; }),
        delete: vi.fn(() => chain),
        select: vi.fn(() => chain),
        eq: vi.fn(() => chain),
        single: vi.fn(() => Promise.resolve({ data: { id: "ig-1" }, error: null })),
        then: (resolve: (v: unknown) => void) => resolve({ error: null }),
      };
      return chain;
    }),
  })),
}));

describe("POST /api/production/recipe-square-link-ignores", () => {
  it("upserts a keg/can ignore with variation_id", async () => {
    upsertCalls.length = 0;
    const { POST } = await import("./route");
    const req = new NextRequest("http://localhost/api/production/recipe-square-link-ignores", {
      method: "POST",
      body: JSON.stringify({ recipe_id: "r1", packaging: "can", variation_id: "v1" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    expect(upsertCalls[0]).toMatchObject({ recipe_id: "r1", packaging: "can", variation_id: "v1" });
  });

  it("rejects a keg/can ignore without variation_id", async () => {
    const { POST } = await import("./route");
    const req = new NextRequest("http://localhost/api/production/recipe-square-link-ignores", {
      method: "POST",
      body: JSON.stringify({ recipe_id: "r1", packaging: "can" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("rejects a draft ignore that carries a variation_id", async () => {
    const { POST } = await import("./route");
    const req = new NextRequest("http://localhost/api/production/recipe-square-link-ignores", {
      method: "POST",
      body: JSON.stringify({ recipe_id: "r1", packaging: "draft", variation_id: "v1" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/production/recipe-square-link-ignores", () => {
  it("400s without id", async () => {
    const { DELETE } = await import("./route");
    const req = new NextRequest("http://localhost/api/production/recipe-square-link-ignores", { method: "DELETE" });
    const res = await DELETE(req);
    expect(res.status).toBe(400);
  });

  it("204s with id", async () => {
    const { DELETE } = await import("./route");
    const req = new NextRequest("http://localhost/api/production/recipe-square-link-ignores?id=ig-1", { method: "DELETE" });
    const res = await DELETE(req);
    expect(res.status).toBe(204);
  });
});
