import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requirePermission: vi.fn().mockResolvedValue(undefined) };
});

const insertCalls: unknown[] = [];
let insertResult: { data: unknown; error: unknown } = { data: { id: "ig-1" }, error: null };
let existingResult: { data: unknown; error: unknown } = { data: { id: "ig-1" }, error: null };

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: vi.fn(async () => ({
    from: vi.fn(() => {
      let isInsert = false;
      const chain = {
        insert: vi.fn((row: unknown) => { isInsert = true; insertCalls.push(row); return chain; }),
        delete: vi.fn(() => chain),
        select: vi.fn(() => chain),
        eq: vi.fn(() => chain),
        single: vi.fn(() => Promise.resolve(isInsert ? insertResult : existingResult)),
        then: (resolve: (v: unknown) => void) => resolve({ error: null }),
      };
      return chain;
    }),
  })),
}));

describe("POST /api/production/recipe-square-link-ignores", () => {
  it("inserts a keg/can ignore with variation_id", async () => {
    insertCalls.length = 0;
    insertResult = { data: { id: "ig-1" }, error: null };
    const { POST } = await import("./route");
    const req = new NextRequest("http://localhost/api/production/recipe-square-link-ignores", {
      method: "POST",
      body: JSON.stringify({ recipe_id: "r1", packaging: "can", variation_id: "v1" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    expect(insertCalls[0]).toMatchObject({ recipe_id: "r1", packaging: "can", variation_id: "v1" });
  });

  it("returns the existing row when re-ignoring an already-ignored cell (23505)", async () => {
    insertCalls.length = 0;
    insertResult = { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
    existingResult = { data: { id: "ig-1", recipe_id: "r1", packaging: "can", variation_id: "v1" }, error: null };
    const { POST } = await import("./route");
    const req = new NextRequest("http://localhost/api/production/recipe-square-link-ignores", {
      method: "POST",
      body: JSON.stringify({ recipe_id: "r1", packaging: "can", variation_id: "v1" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ id: "ig-1" });
  });

  it("500s on a non-unique-violation insert error", async () => {
    insertResult = { data: null, error: { code: "42501", message: "permission denied" } };
    const { POST } = await import("./route");
    const req = new NextRequest("http://localhost/api/production/recipe-square-link-ignores", {
      method: "POST",
      body: JSON.stringify({ recipe_id: "r1", packaging: "can", variation_id: "v1" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(500);
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
