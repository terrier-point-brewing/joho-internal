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
 *   manage  — master data: create/edit/delete an ingredient or packaging item
 *   operate — stock movements: adjustments and receipts
 *
 * Drift here is silent and asymmetric: before this file existed, POST
 * /ingredients and POST /ingredients/bulk gated at `operate` while
 * PATCH/DELETE on the same resource gated at `manage`, so a brewer could
 * bulk-create ingredients they could not then edit one at a time.
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
  it("POST /ingredients requires manage — creating master data, not a stock movement", async () => {
    const { POST } = await import("./ingredients/route");
    expect(await gateOf(() => POST(post({ name: "Cascade", unit: "oz" })))).toEqual({
      scope: "production.inventory",
      level: "manage",
    });
  });

  it("POST /ingredients/bulk requires manage — same write as the single-row create", async () => {
    const { POST } = await import("./ingredients/bulk/route");
    expect(
      await gateOf(() => POST(post({ rows: [{ name: "Cascade", unit: "oz" }] }))),
    ).toEqual({ scope: "production.inventory", level: "manage" });
  });

  it("POST /packaging requires manage — mirrors PATCH/DELETE on /packaging/[id]", async () => {
    const { POST } = await import("./packaging/route");
    expect(await gateOf(() => POST(post({ type: "can", name: "16oz" })))).toEqual({
      scope: "production.inventory",
      level: "manage",
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

  it("cannot write ingredient or packaging master data", () => {
    expect(can(brewer, CAP.ingredientMasterEdit.scope, CAP.ingredientMasterEdit.level)).toBe(false);
    expect(can(brewer, CAP.packagingMasterEdit.scope, CAP.packagingMasterEdit.level)).toBe(false);
  });

  it("can still adjust and receive stock", () => {
    expect(can(brewer, CAP.inventoryOperate.scope, CAP.inventoryOperate.level)).toBe(true);
  });
});
