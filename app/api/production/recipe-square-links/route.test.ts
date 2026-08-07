import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// The POST busts the live-catalog cache before mirroring the linked item.
vi.mock("next/cache", () => ({ revalidateTag: vi.fn() }));

// Mirroring the linked item is a side effect of linking, not the subject of
// these tests; the behaviour has its own coverage in lib/square.
vi.mock("@/lib/square/ensureCatalogItem", () => ({
  ensureCatalogItemMirrored: vi.fn().mockResolvedValue({ alreadyMirrored: true, synced: false }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: vi.fn(() => ({})) }));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requirePermission: vi.fn().mockResolvedValue(undefined) };
});

const deleteEqCalls: Array<{ field: string; value: unknown }> = [];

interface Chain {
  delete: () => Chain;
  select: () => Chain;
  insert: () => Chain;
  eq: (field: string, value: unknown) => Chain;
  order: () => Chain;
  single: () => Promise<unknown>;
  then: (resolve: (v: unknown) => void) => void;
}

function makeChain(table: string, result: unknown): Chain {
  let op: "select" | "delete" | "insert" | null = null;

  const chain: Chain = {
    delete: vi.fn(() => {
      op = "delete";
      return chain;
    }),
    select: vi.fn(() => {
      if (op === null) op = "select";
      return chain;
    }),
    insert: vi.fn(() => {
      op = "insert";
      return chain;
    }),
    eq: vi.fn((field: string, value: unknown) => {
      if (table === "recipe_square_links" && op === "delete") {
        deleteEqCalls.push({ field, value });
      }
      return chain;
    }),
    order: vi.fn(() => chain),
    single: vi.fn(() => Promise.resolve(result)),
    then: (resolve: (v: unknown) => void) => resolve(result),
  };

  return chain;
}

const tableResults: Record<string, unknown> = {
  packaging_variations: { data: { container_id: "container-1" }, error: null },
  square_catalog_items: { data: { id: "catalog-item-1" }, error: null },
  square_catalog_variations: { data: { id: "catalog-variation-1" }, error: null },
  recipe_square_links: {
    data: { id: "link-1", recipe_id: "recipe-1", packaging: "keg" },
    error: null,
  },
};

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: vi.fn(async () => ({
    from: vi.fn((table: string) => makeChain(table, tableResults[table])),
  })),
}));

describe("POST /api/production/recipe-square-links", () => {
  beforeEach(() => {
    deleteEqCalls.length = 0;
  });

  it("replaces an existing link keyed by square_variation_id, not the old variation_id", async () => {
    const { POST } = await import("./route");

    const req = new NextRequest("http://localhost/api/production/recipe-square-links", {
      method: "POST",
      body: JSON.stringify({
        recipe_id: "recipe-1",
        packaging: "keg",
        variation_id: "variation-new",
        square_variation_id: "sq-variation-1",
        square_item_id: "sq-item-1",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);

    // The stale row (created with variation_id: null) must be found and
    // replaced via square_variation_id — filtering on the *new* variation_id
    // would never match it, leaving both rows in place.
    expect(deleteEqCalls).toEqual([
      { field: "recipe_id", value: "recipe-1" },
      { field: "square_variation_id", value: "sq-variation-1" },
    ]);
  });
});
