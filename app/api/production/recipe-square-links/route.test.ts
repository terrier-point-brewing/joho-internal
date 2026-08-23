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
  upsert: () => Chain;
  eq: (field: string, value: unknown) => Chain;
  order: () => Chain;
  single: () => Promise<unknown>;
  maybeSingle: () => Promise<unknown>;
  then: (resolve: (v: unknown) => void) => void;
}

/**
 * A table's canned answers. `recipe_square_links` needs two: the route SELECTs
 * the packagings already holding a Square variation (an array) before it
 * INSERTs the new link (a row), and one shared value cannot be both.
 */
type TableResult = unknown | { select: unknown; insert: unknown };

function resultFor(result: unknown, op: string | null): unknown {
  if (result && typeof result === "object" && "select" in (result as object) && "insert" in (result as object)) {
    const byOp = result as { select: unknown; insert: unknown };
    return op === "insert" ? byOp.insert : byOp.select;
  }
  return result;
}

function makeChain(table: string, result: TableResult): Chain {
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
    upsert: vi.fn(() => {
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
    single: vi.fn(() => Promise.resolve(resultFor(result, op))),
    maybeSingle: vi.fn(() => Promise.resolve(resultFor(result, op))),
    then: (resolve: (v: unknown) => void) => resolve(resultFor(result, op)),
  };

  return chain;
}

/** Packagings already holding the Square variation being linked. Per test. */
let holders: unknown[] = [];

const tableResults = (): Record<string, TableResult> => ({
  packaging_variations: {
    data: { container_id: "container-1", name: "Incoming Packaging", partner_id: null, total_volume_fl_oz: 661 },
    error: null,
  },
  square_catalog_items: { data: { id: "catalog-item-1" }, error: null },
  square_catalog_variations: { data: { id: "catalog-variation-1" }, error: null },
  recipe_square_links: {
    select: { data: holders, error: null },
    insert: { data: { id: "link-1", recipe_id: "recipe-1", packaging: "keg" }, error: null },
  },
  square_fungible_skus: { data: [], error: null },
});

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: vi.fn(async () => ({
    from: vi.fn((table: string) => makeChain(table, tableResults()[table])),
  })),
}));

function linkRequest(extra: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/production/recipe-square-links", {
    method: "POST",
    body: JSON.stringify({
      recipe_id: "recipe-1",
      packaging: "keg",
      square_variation_id: "sq-variation-1",
      square_item_id: "sq-item-1",
      ...extra,
    }),
  });
}

describe("POST /api/production/recipe-square-links", () => {
  beforeEach(() => {
    deleteEqCalls.length = 0;
    holders = [];
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

  // Before this, a second packaging pointed at an occupied Square variation
  // silently took the mapping off the first. Nobody decided that, and nothing
  // said it had happened — the green tick just moved.
  it("refuses to steal an occupied Square variation, and names who holds it", async () => {
    holders = [
      {
        id: "link-existing",
        variation_id: "variation-printed",
        packaging: "keg",
        packaging_variations: { name: "Printed Can Case", partner_id: null, total_volume_fl_oz: 661 },
      },
    ];
    const { POST } = await import("./route");

    const res = await POST(linkRequest({ variation_id: "variation-new" }));

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("Printed Can Case");
    expect(body.conflict.holders).toHaveLength(1);
    // Nothing was written: the choice is the operator's to make.
    expect(deleteEqCalls).toEqual([]);
  });

  it("keeps the incumbent when told to share, clearing only this packaging's own stale row", async () => {
    holders = [
      {
        id: "link-existing",
        variation_id: "variation-printed",
        packaging: "keg",
        packaging_variations: { name: "Printed Can Case", partner_id: null, total_volume_fl_oz: 661 },
      },
    ];
    const { POST } = await import("./route");

    const res = await POST(linkRequest({ variation_id: "variation-new", on_conflict: "share" }));

    expect(res.status).toBe(201);
    // Scoped by variation_id, so the incumbent's row survives — without that
    // third filter, "share" would delete exactly what it is meant to keep.
    expect(deleteEqCalls).toEqual([
      { field: "recipe_id", value: "recipe-1" },
      { field: "square_variation_id", value: "sq-variation-1" },
      { field: "variation_id", value: "variation-new" },
    ]);
  });

  it("still replaces the incumbent when told to move", async () => {
    holders = [
      {
        id: "link-existing",
        variation_id: "variation-printed",
        packaging: "keg",
        packaging_variations: { name: "Printed Can Case", partner_id: null, total_volume_fl_oz: 661 },
      },
    ];
    const { POST } = await import("./route");

    const res = await POST(linkRequest({ variation_id: "variation-new", on_conflict: "move" }));

    expect(res.status).toBe(201);
    expect(deleteEqCalls).toEqual([
      { field: "recipe_id", value: "recipe-1" },
      { field: "square_variation_id", value: "sq-variation-1" },
    ]);
  });

  // A partner's branded packaging leaves on a contract shipment, never over the
  // bar. Sharing a button with house stock would route around that entirely.
  it("refuses to share a button between house and partner packaging", async () => {
    holders = [
      {
        id: "link-existing",
        variation_id: "variation-partner",
        packaging: "keg",
        packaging_variations: { name: "Fortnight 1/6 Keg", partner_id: "partner-1", total_volume_fl_oz: 661 },
      },
    ];
    const { POST } = await import("./route");

    const res = await POST(linkRequest({ variation_id: "variation-new", on_conflict: "share" }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("partner");
    expect(deleteEqCalls).toEqual([]);
  });
});
