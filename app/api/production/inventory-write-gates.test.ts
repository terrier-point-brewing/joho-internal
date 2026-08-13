import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { ROLE_BUNDLES } from "@/lib/auth/roleGrants";
import { can } from "@/lib/auth/resolve";

/**
 * Pins the capability each inventory WRITE route gates on.
 *
 * The inventory scope carries two tiers, and the split is easy to get wrong
 * because both live on `production.inventory`:
 *
 *   manage  — edit/delete an existing ingredient or packaging item, and every
 *             BULK path (bulk edit, bulk upload), which rewrites many rows
 *   operate — stock movements (adjustments, receipts) and creating ONE new
 *             ingredient or packaging item
 *
 * The single-row create sitting at `operate` while PATCH/DELETE on the same
 * resource sits at `manage` is deliberate, not drift: an operator taking
 * delivery of a new hop can add the row, but cannot rewrite or remove rows
 * that already exist, and cannot reach the bulk paths at all.
 *
 * These assertions are on the (scope, level) COORDINATE, not the CAP name, so
 * re-pointing a capability at a different scope fails here too.
 */

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requirePermission: vi.fn().mockResolvedValue(undefined) };
});

// Both routes reach Supabase after the gate; the gate is all we assert, so the
// chain only has to not throw.
const okChain = {
  insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: {}, error: null }) }) }),
};
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: vi.fn(async () => ({ from: () => okChain })),
}));

const gateMock = vi.mocked(requirePermission);

/** The capability a handler actually demanded, as a coordinate. */
async function gateOf(run: () => Promise<unknown>) {
  await run();
  expect(gateMock).toHaveBeenCalledTimes(1);
  return gateMock.mock.calls[0][0];
}

function post(body: unknown) {
  return new NextRequest("http://localhost/x", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => gateMock.mockClear());

describe("inventory write gates", () => {
  it("POST /ingredients requires only operate — creating ONE row is an operator action", async () => {
    const { POST } = await import("./ingredients/route");
    expect(await gateOf(() => POST(post({ name: "Cascade", unit: "oz" })))).toEqual({
      scope: "production.inventory",
      level: "operate",
    });
  });

  it("POST /ingredients/bulk requires manage — a bulk path rewrites many rows, unlike the single create", async () => {
    const { POST } = await import("./ingredients/bulk/route");
    expect(
      await gateOf(() => POST(post({ rows: [{ name: "Cascade", unit: "oz" }] }))),
    ).toEqual({ scope: "production.inventory", level: "manage" });
  });

  it("POST /packaging requires only operate — mirrors POST /ingredients, NOT PATCH/DELETE on [id]", async () => {
    const { POST } = await import("./packaging/route");
    expect(await gateOf(() => POST(post({ type: "can", name: "16oz" })))).toEqual({
      scope: "production.inventory",
      level: "operate",
    });
  });

  it("stock movements stay at operate, so a brewer keeps their day job", async () => {
    const { POST } = await import("./stock-adjustments/bulk/route");
    expect(
      await gateOf(() => POST(post({ adjustments: [] }))),
    ).toEqual({ scope: "production.inventory", level: "operate" });
  });
});

describe("brewer lands on the intended side of that split", () => {
  const brewer = ROLE_BUNDLES.brewer;

  it("cannot edit or delete existing ingredient or packaging master data", () => {
    expect(can(brewer, CAP.ingredientMasterEdit.scope, CAP.ingredientMasterEdit.level)).toBe(false);
    expect(can(brewer, CAP.packagingMasterEdit.scope, CAP.packagingMasterEdit.level)).toBe(false);
  });

  it("can still add one new ingredient or packaging item", () => {
    expect(can(brewer, CAP.ingredientMasterCreate.scope, CAP.ingredientMasterCreate.level)).toBe(true);
    expect(can(brewer, CAP.packagingMasterCreate.scope, CAP.packagingMasterCreate.level)).toBe(true);
  });

  it("can still adjust and receive stock", () => {
    expect(can(brewer, CAP.inventoryOperate.scope, CAP.inventoryOperate.level)).toBe(true);
  });
});
