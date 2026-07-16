# Bulk "received" inventory adjustment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user record one invoice's worth of received ingredients (or packaging) — multiple
items, quantities, and purchase costs — in one form, with a single shared freight charge split
across the lines by weight, instead of submitting N separate single-item adjustments.

**Architecture:** Two new pure `lib/production/` functions (freight-by-weight allocation, and the
landed-cost/weighted-average-cost calc extracted out of the existing single-item routes) sit
underneath two new `/bulk` API routes (one for ingredients, one for packaging) that loop the same
insert-adjustment-row + update-item-stock pattern the existing single-item routes already use. One
new generic `BulkReceiveModal` UI component, parameterized by item type, is wired into both
`IngredientsTab` and `PackagingTab` via a new "Bulk Receive" button.

**Tech Stack:** Next.js 16 App Router route handlers, Supabase Postgres (`@supabase/supabase-js`
server client), React (client components), Vitest.

## Global Constraints

- No schema changes — freight allocation is written into the existing `shipping_cost` column on
  `stock_adjustments` / `packaging_stock_adjustments`; no new columns, no new tables.
- No new DB transaction/RPC machinery — bulk routes loop the same per-item writes (RPC
  `adjust_ingredient_stock` for ingredients, plain `.update()` for packaging) the single-item
  routes already use. Partial failure across a batch is possible and surfaced, not rolled back —
  same risk profile as today's single-item routes, just visible across more lines at once.
  Scope: "received" adjustments only — no bulk `used`/`waste`/`inventory_count`.
- `packaging_items` has no `unit` column — packaging bulk lines always pass an unmatchable unit to
  the freight allocator, which falls back to splitting freight by raw quantity (see spec's
  "Packaging note").
- Role gate: `requireRole(["brewer"])` on every new/modified route, matching the existing
  single-item routes.
- New/modified `lib/` modules ship with co-located `*.test.ts` (repo policy, `CLAUDE.md`). Most
  `app/api/**` routes in this codebase have no dedicated test file (only
  `app/api/production/recipe-square-links/route.test.ts` does today) — business logic is mostly
  extracted into tested `lib/` functions and routes stay thin glue. The two new bulk routes get a
  lightweight route test anyway (mirroring that one existing file's Supabase-stub pattern), since
  the spec explicitly calls for validation + happy-path + role-gate coverage at the route level.
- UI: reuse existing primitives only — `Modal`/`Field`/`ModalActions` from
  `app/production/components/shared.tsx`, `.inp` for inputs, `.btn-primary`/`.btn-secondary` for
  buttons. No raw colors, no hand-rolled primitives (`docs/UI_STANDARD.md`).
- `npm run verify` (lint + typecheck + tests) must pass before this is considered done.

---

### Task 1: Freight-by-weight allocation

**Files:**
- Create: `lib/production/freightAllocation.ts`
- Test: `lib/production/freightAllocation.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface FreightLineInput {
    unit: string;
    quantity: number;
  }
  export function allocateFreightByWeight(
    lines: FreightLineInput[],
    freightTotalDollars: number
  ): number[]; // dollars per line, same order/length as `lines`
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// lib/production/freightAllocation.test.ts
import { describe, it, expect } from "vitest";
import { allocateFreightByWeight } from "./freightAllocation";

describe("allocateFreightByWeight", () => {
  it("returns [] for no lines", () => {
    expect(allocateFreightByWeight([], 100)).toEqual([]);
  });

  it("splits proportional to quantity when all lines share the same known unit", () => {
    const result = allocateFreightByWeight(
      [{ unit: "lbs", quantity: 10 }, { unit: "lbs", quantity: 30 }],
      40
    );
    expect(result).toEqual([10, 30]);
  });

  it("splits by true weight (not raw quantity) across mixed known units", () => {
    const result = allocateFreightByWeight(
      [{ unit: "lb", quantity: 10 }, { unit: "oz", quantity: 16 }],
      17.6
    );
    expect(result).toEqual([16, 1.6]);
  });

  it("treats an unmatched unit as equivalent to the batch's majority matched unit", () => {
    const result = allocateFreightByWeight(
      [
        { unit: "lbs", quantity: 10 },
        { unit: "lbs", quantity: 10 },
        { unit: "bricks", quantity: 5 },
      ],
      40
    );
    expect(result).toEqual([16, 16, 8]);
  });

  it("falls back to raw-quantity proportioning when no line matches a known unit", () => {
    const result = allocateFreightByWeight(
      [{ unit: "bricks", quantity: 10 }, { unit: "cases", quantity: 30 }],
      40
    );
    expect(result).toEqual([10, 30]);
  });

  it("breaks a majority-unit tie deterministically by first occurrence", () => {
    // "oz" and "lb" both matched once each -> tie -> "oz" wins (appears first).
    // bricks (unmatched) is then treated as 1 brick = 1 oz.
    const result = allocateFreightByWeight(
      [
        { unit: "oz", quantity: 5 },
        { unit: "lb", quantity: 2 },
        { unit: "bricks", quantity: 3 },
      ],
      40
    );
    expect(result).toEqual([5, 32, 3]);
  });

  it("distributes leftover cents to the lowest-index line on an exact tie", () => {
    const result = allocateFreightByWeight(
      [
        { unit: "lb", quantity: 1 },
        { unit: "lb", quantity: 1 },
        { unit: "lb", quantity: 1 },
      ],
      10
    );
    expect(result).toEqual([3.34, 3.33, 3.33]);
    expect(result.reduce((s, n) => s + n, 0)).toBeCloseTo(10, 2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/production/freightAllocation.test.ts`
Expected: FAIL — `Cannot find module './freightAllocation'` (file doesn't exist yet).

- [ ] **Step 3: Implement**

```ts
// lib/production/freightAllocation.ts

/** Ounces per 1 unit, keyed by normalized unit string. */
const OZ_PER_UNIT: Record<string, number> = {
  oz: 1, ounce: 1, ounces: 1,
  lb: 16, lbs: 16, pound: 16, pounds: 16, "#": 16,
  g: 0.035274, gram: 0.035274, grams: 0.035274,
  kg: 35.274, kilogram: 35.274, kilograms: 35.274,
};

function normalizeUnit(unit: string): string {
  return unit.trim().toLowerCase().replace(/\.$/, "");
}

function ozPerUnit(unit: string): number | null {
  return OZ_PER_UNIT[normalizeUnit(unit)] ?? null;
}

export interface FreightLineInput {
  unit: string;
  quantity: number;
}

/**
 * Splits `freightTotalDollars` across `lines` proportional to weight, derived
 * per-line from `unit` (fuzzy-matched against a small known-weight-unit table) x
 * `quantity`. Lines whose unit doesn't match a known weight unit are treated as
 * 1 [their unit] = 1 [the batch's majority matched unit]; if no line matches any
 * known unit, every line falls back to weight = quantity (pure quantity split).
 * Uses largest-remainder rounding so the returned dollars sum exactly to
 * `freightTotalDollars` (to the cent).
 */
export function allocateFreightByWeight(
  lines: FreightLineInput[],
  freightTotalDollars: number
): number[] {
  if (lines.length === 0) return [];

  const factors = lines.map((l) => ozPerUnit(l.unit));

  // Majority matched unit (by count, ties broken by first occurrence).
  const counts = new Map<string, number>();
  const order: string[] = [];
  lines.forEach((l, i) => {
    if (factors[i] == null) return;
    const norm = normalizeUnit(l.unit);
    if (!counts.has(norm)) { counts.set(norm, 0); order.push(norm); }
    counts.set(norm, counts.get(norm)! + 1);
  });
  let majorityFactor = 1;
  if (order.length > 0) {
    let best = order[0];
    for (const u of order) {
      if (counts.get(u)! > counts.get(best)!) best = u;
    }
    majorityFactor = OZ_PER_UNIT[best];
  }

  const weights = lines.map((l, i) => l.quantity * (factors[i] ?? majorityFactor));
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  if (totalWeight <= 0) return lines.map(() => 0);

  const totalCents = Math.round(freightTotalDollars * 100);
  const raw = weights.map((w) => (w / totalWeight) * totalCents);
  const floors = raw.map((r) => Math.floor(r));
  let remainder = totalCents - floors.reduce((s, f) => s + f, 0);

  const byFrac = raw
    .map((r, idx) => ({ idx, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.idx - b.idx);
  const cents = [...floors];
  for (let k = 0; k < byFrac.length && remainder > 0; k++) {
    cents[byFrac[k].idx] += 1;
    remainder--;
  }

  return cents.map((c) => c / 100);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/production/freightAllocation.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/production/freightAllocation.ts lib/production/freightAllocation.test.ts
git commit -m "$(cat <<'EOF'
feat(production): add freight-by-weight allocation helper

Splits a shared freight/shipping charge across bulk-received lines
proportional to weight, fuzzy-matching each line's free-text unit
against a small known-weight-unit table with a raw-quantity fallback.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Extract shared landed-cost/WAC calc; refactor existing routes onto it

**Files:**
- Create: `lib/production/receivedAdjustment.ts`
- Test: `lib/production/receivedAdjustment.test.ts`
- Modify: `app/api/production/stock-adjustments/route.ts:1-4,54-64`
- Modify: `app/api/production/packaging-adjustments/route.ts:1-4,52-65`

**Interfaces:**
- Produces:
  ```ts
  export interface ReceivedAdjustmentInput {
    currentStock: number;
    currentCostPerUnit: number | null;
    quantity: number;      // delta, > 0
    purchaseCost: number;  // $ per unit, > 0
    shippingCost: number;  // $ total for this line, >= 0
  }
  export interface ReceivedAdjustmentResult {
    landedCostPerUnit: number;
    newStock: number;
    newCostPerUnit: number;
  }
  export function computeReceivedAdjustment(
    input: ReceivedAdjustmentInput
  ): ReceivedAdjustmentResult;
  ```
- Consumes (Task 1): none.

- [ ] **Step 1: Write the failing tests**

```ts
// lib/production/receivedAdjustment.test.ts
import { describe, it, expect } from "vitest";
import { computeReceivedAdjustment } from "./receivedAdjustment";

describe("computeReceivedAdjustment", () => {
  it("bakes shipping into landed cost and recomputes weighted-average cost", () => {
    const result = computeReceivedAdjustment({
      currentStock: 100,
      currentCostPerUnit: 2.0,
      quantity: 50,
      purchaseCost: 2.5,
      shippingCost: 25,
    });
    expect(result.landedCostPerUnit).toBe(3.0);
    expect(result.newStock).toBe(150);
    expect(result.newCostPerUnit).toBeCloseTo(2.333333, 5);
  });

  it("treats a null currentCostPerUnit as 0 (brand-new item)", () => {
    const result = computeReceivedAdjustment({
      currentStock: 0,
      currentCostPerUnit: null,
      quantity: 20,
      purchaseCost: 5.0,
      shippingCost: 10,
    });
    expect(result.landedCostPerUnit).toBe(5.5);
    expect(result.newStock).toBe(20);
    expect(result.newCostPerUnit).toBe(5.5);
  });

  it("landed cost equals purchase cost when shipping is 0", () => {
    const result = computeReceivedAdjustment({
      currentStock: 10,
      currentCostPerUnit: 1.0,
      quantity: 10,
      purchaseCost: 2.0,
      shippingCost: 0,
    });
    expect(result.landedCostPerUnit).toBe(2.0);
    expect(result.newStock).toBe(20);
    expect(result.newCostPerUnit).toBe(1.5);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/production/receivedAdjustment.test.ts`
Expected: FAIL — `Cannot find module './receivedAdjustment'`

- [ ] **Step 3: Implement**

```ts
// lib/production/receivedAdjustment.ts

export interface ReceivedAdjustmentInput {
  currentStock: number;
  currentCostPerUnit: number | null;
  quantity: number;
  purchaseCost: number;
  shippingCost: number;
}

export interface ReceivedAdjustmentResult {
  landedCostPerUnit: number;
  newStock: number;
  newCostPerUnit: number;
}

/**
 * Landed cost bakes shipping into the per-unit cost of a "received" adjustment;
 * new cost is the stock-weighted average of the existing on-hand value and the
 * newly landed value. Shared by the single-item and bulk received-adjustment
 * routes for both ingredients and packaging so the math has one source of truth.
 */
export function computeReceivedAdjustment(
  input: ReceivedAdjustmentInput
): ReceivedAdjustmentResult {
  const { currentStock, currentCostPerUnit, quantity, purchaseCost, shippingCost } = input;
  const landedCostPerUnit = (purchaseCost * quantity + shippingCost) / quantity;
  const newStock = currentStock + quantity;
  const newCostPerUnit =
    newStock > 0
      ? (currentStock * (currentCostPerUnit ?? 0) + quantity * landedCostPerUnit) / newStock
      : landedCostPerUnit;
  return { landedCostPerUnit, newStock, newCostPerUnit };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/production/receivedAdjustment.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Refactor `app/api/production/stock-adjustments/route.ts` to use it**

Add the import (top of file, alongside the existing imports):

```ts
import { computeReceivedAdjustment } from "@/lib/production/receivedAdjustment";
```

Replace the existing `if (type === "received" ...)` block (current lines 54-64):

```ts
  if (type === "received" && purchase_cost != null && Number(purchase_cost) > 0) {
    adjCostPerUnit = Number(purchase_cost);
    // Landed cost per unit: bake shipping into WAC so deposit calculations see full cost.
    const shippingAmt = shipping_cost != null ? Number(shipping_cost) : 0;
    const { landedCostPerUnit, newCostPerUnit: computedCost } = computeReceivedAdjustment({
      currentStock: currentQty,
      currentCostPerUnit: currentCost,
      quantity: delta,
      purchaseCost: adjCostPerUnit,
      shippingCost: shippingAmt,
    });
    totalValueChange = delta * landedCostPerUnit;
    newCostPerUnit = computedCost;
  }
```

- [ ] **Step 6: Refactor `app/api/production/packaging-adjustments/route.ts` to use it**

Add the import (top of file, alongside the existing imports):

```ts
import { computeReceivedAdjustment } from "@/lib/production/receivedAdjustment";
```

Replace the existing "Weighted-average cost update" block (current lines 52-65):

```ts
  // Weighted-average cost update for "received"
  let newCostPerUnit = currentCost;
  let totalValueChange = null;
  if (type === "received" && purchase_cost != null && purchase_cost !== "") {
    const pc = Number(purchase_cost);
    // Landed cost per unit: bake shipping into WAC so deposit calculations see full cost.
    const shippingAmt = shipping_cost != null ? Number(shipping_cost) : 0;
    const { landedCostPerUnit, newCostPerUnit: computedCost } = computeReceivedAdjustment({
      currentStock,
      currentCostPerUnit: currentCost,
      quantity: delta,
      purchaseCost: pc,
      shippingCost: shippingAmt,
    });
    newCostPerUnit = computedCost;
    totalValueChange = delta * landedCostPerUnit;
  }
```

- [ ] **Step 7: Verify no regressions**

Run: `npm run verify`
Expected: lint, typecheck, and all tests (including the 10 new ones) pass. This refactor changes
no observable behavior — `computeReceivedAdjustment`'s formula is identical to what each route
inlined before (confirmed by inspection: both routes computed
`(purchaseCost*delta + shippingCost) / delta` for landed cost and the same stock-weighted average
for new cost).

- [ ] **Step 8: Commit**

```bash
git add lib/production/receivedAdjustment.ts lib/production/receivedAdjustment.test.ts \
  app/api/production/stock-adjustments/route.ts app/api/production/packaging-adjustments/route.ts
git commit -m "$(cat <<'EOF'
refactor(production): extract shared received-adjustment landed-cost/WAC calc

Both the ingredient and packaging stock-adjustment routes inlined the
same landed-cost + weighted-average-cost formula. Extracting it gives
the upcoming bulk routes the same math with one source of truth,
verified behavior-identical to the prior inline versions.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Bulk "received" route for ingredients

**Files:**
- Create: `app/api/production/stock-adjustments/bulk/route.ts`
- Test: `app/api/production/stock-adjustments/bulk/route.test.ts`

**Interfaces:**
- Consumes (Task 1): `allocateFreightByWeight(lines: FreightLineInput[], freightTotalDollars: number): number[]`
- Consumes (Task 2): `computeReceivedAdjustment(input: ReceivedAdjustmentInput): ReceivedAdjustmentResult`
- Produces: `POST /api/production/stock-adjustments/bulk`
  - Request body: `{ lines: { ingredient_id: string; quantity: number; purchase_cost: number }[]; freight_total: number }`
  - Response: `{ results: { ingredient_id: string; new_stock: number; new_cost_per_unit: number; shipping_cost: number }[]; errors: { ingredient_id: string; error: string }[] }`
    with status `201` if `errors` is empty, `207` otherwise.

- [ ] **Step 1: Write the failing tests**

```ts
// app/api/production/stock-adjustments/bulk/route.test.ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run app/api/production/stock-adjustments/bulk/route.test.ts`
Expected: FAIL — `Cannot find module './route'` (route file doesn't exist yet).

- [ ] **Step 3: Implement**

```ts
// app/api/production/stock-adjustments/bulk/route.ts
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { allocateFreightByWeight } from "@/lib/production/freightAllocation";
import { computeReceivedAdjustment } from "@/lib/production/receivedAdjustment";

export const dynamic = "force-dynamic";

interface BulkLine {
  ingredient_id: string;
  quantity: number;
  purchase_cost: number;
}

export async function POST(req: NextRequest) {
  try { await requireRole(["brewer"]); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const body = await req.json();
  const lines: BulkLine[] = Array.isArray(body.lines) ? body.lines : [];
  const freightTotal = Number(body.freight_total ?? 0);

  if (lines.length === 0)
    return NextResponse.json({ error: "At least one line is required" }, { status: 400 });
  if (!(freightTotal >= 0))
    return NextResponse.json({ error: "freight_total must be >= 0" }, { status: 400 });

  const ids = lines.map((l) => l.ingredient_id);
  if (new Set(ids).size !== ids.length)
    return NextResponse.json({ error: "Duplicate ingredient_id in lines" }, { status: 400 });

  for (const l of lines) {
    if (!(Number(l.quantity) > 0))
      return NextResponse.json({ error: `quantity must be > 0 for ingredient ${l.ingredient_id}` }, { status: 400 });
    if (!(Number(l.purchase_cost) > 0))
      return NextResponse.json({ error: `purchase_cost must be > 0 for ingredient ${l.ingredient_id}` }, { status: 400 });
  }

  const { data: ingredientsData, error: fetchErr } = await supabase
    .from("ingredients")
    .select("id, stock_quantity, cost_per_unit, unit")
    .in("id", ids);
  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });

  const byId = new Map((ingredientsData ?? []).map((i) => [i.id, i]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0)
    return NextResponse.json({ error: `Ingredient(s) not found: ${missing.join(", ")}` }, { status: 404 });

  const shippingByLine = allocateFreightByWeight(
    lines.map((l) => ({ unit: byId.get(l.ingredient_id)!.unit as string, quantity: Number(l.quantity) })),
    freightTotal
  );

  const results: { ingredient_id: string; new_stock: number; new_cost_per_unit: number; shipping_cost: number }[] = [];
  const errors: { ingredient_id: string; error: string }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const current = byId.get(line.ingredient_id)!;
    const quantity = Number(line.quantity);
    const purchaseCost = Number(line.purchase_cost);
    const shippingCost = shippingByLine[i];

    const { landedCostPerUnit, newStock, newCostPerUnit } = computeReceivedAdjustment({
      currentStock: current.stock_quantity ?? 0,
      currentCostPerUnit: current.cost_per_unit ?? null,
      quantity,
      purchaseCost,
      shippingCost,
    });

    const { error: adjErr } = await supabase.from("stock_adjustments").insert({
      ingredient_id: line.ingredient_id,
      type: "received",
      quantity,
      note: null,
      cost_per_unit: purchaseCost,
      total_value_change: quantity * landedCostPerUnit,
      shipping_cost: shippingCost > 0 ? shippingCost : null,
      unit: current.unit,
    });
    if (adjErr) { errors.push({ ingredient_id: line.ingredient_id, error: adjErr.message }); continue; }

    const { error: rpcErr } = await supabase.rpc("adjust_ingredient_stock", {
      p_id: line.ingredient_id,
      p_delta: quantity,
    });
    if (rpcErr) { errors.push({ ingredient_id: line.ingredient_id, error: rpcErr.message }); continue; }

    const { error: costErr } = await supabase
      .from("ingredients")
      .update({ cost_per_unit: newCostPerUnit })
      .eq("id", line.ingredient_id);
    if (costErr) { errors.push({ ingredient_id: line.ingredient_id, error: costErr.message }); continue; }

    results.push({
      ingredient_id: line.ingredient_id,
      new_stock: newStock,
      new_cost_per_unit: newCostPerUnit,
      shipping_cost: shippingCost,
    });
  }

  return NextResponse.json({ results, errors }, { status: errors.length === 0 ? 201 : 207 });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run app/api/production/stock-adjustments/bulk/route.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add app/api/production/stock-adjustments/bulk/route.ts app/api/production/stock-adjustments/bulk/route.test.ts
git commit -m "$(cat <<'EOF'
feat(production): add bulk received-adjustment route for ingredients

POST /api/production/stock-adjustments/bulk accepts multiple
ingredient lines plus one shared freight total, allocates freight by
weight, and writes each line through the same landed-cost/WAC path
the single-item route uses.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Bulk "received" route for packaging

**Files:**
- Create: `app/api/production/packaging-adjustments/bulk/route.ts`
- Test: `app/api/production/packaging-adjustments/bulk/route.test.ts`

**Interfaces:**
- Consumes (Task 1 & 2): same as Task 3.
- Produces: `POST /api/production/packaging-adjustments/bulk`
  - Request body: `{ lines: { packaging_item_id: string; quantity: number; purchase_cost: number }[]; freight_total: number }`
  - Response: `{ results: { packaging_item_id: string; new_stock: number; new_cost_per_unit: number; shipping_cost: number }[]; errors: { packaging_item_id: string; error: string }[] }`
    with status `201` if `errors` is empty, `207` otherwise.

- [ ] **Step 1: Write the failing tests**

```ts
// app/api/production/packaging-adjustments/bulk/route.test.ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run app/api/production/packaging-adjustments/bulk/route.test.ts`
Expected: FAIL — `Cannot find module './route'` (route file doesn't exist yet).

- [ ] **Step 3: Implement**

```ts
// app/api/production/packaging-adjustments/bulk/route.ts
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { allocateFreightByWeight } from "@/lib/production/freightAllocation";
import { computeReceivedAdjustment } from "@/lib/production/receivedAdjustment";

export const dynamic = "force-dynamic";

interface BulkLine {
  packaging_item_id: string;
  quantity: number;
  purchase_cost: number;
}

export async function POST(req: NextRequest) {
  try { await requireRole(["brewer"]); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const body = await req.json();
  const lines: BulkLine[] = Array.isArray(body.lines) ? body.lines : [];
  const freightTotal = Number(body.freight_total ?? 0);

  if (lines.length === 0)
    return NextResponse.json({ error: "At least one line is required" }, { status: 400 });
  if (!(freightTotal >= 0))
    return NextResponse.json({ error: "freight_total must be >= 0" }, { status: 400 });

  const ids = lines.map((l) => l.packaging_item_id);
  if (new Set(ids).size !== ids.length)
    return NextResponse.json({ error: "Duplicate packaging_item_id in lines" }, { status: 400 });

  for (const l of lines) {
    if (!(Number(l.quantity) > 0))
      return NextResponse.json({ error: `quantity must be > 0 for packaging item ${l.packaging_item_id}` }, { status: 400 });
    if (!(Number(l.purchase_cost) > 0))
      return NextResponse.json({ error: `purchase_cost must be > 0 for packaging item ${l.packaging_item_id}` }, { status: 400 });
  }

  const { data: itemsData, error: fetchErr } = await supabase
    .from("packaging_items")
    .select("id, stock_quantity, unit_cost")
    .in("id", ids);
  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });

  const byId = new Map((itemsData ?? []).map((i) => [i.id, i]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0)
    return NextResponse.json({ error: `Packaging item(s) not found: ${missing.join(", ")}` }, { status: 404 });

  // packaging_items has no `unit` column, so every line gets an unmatchable unit —
  // allocateFreightByWeight's fallback then splits freight by raw quantity.
  const shippingByLine = allocateFreightByWeight(
    lines.map((l) => ({ unit: "", quantity: Number(l.quantity) })),
    freightTotal
  );

  const results: { packaging_item_id: string; new_stock: number; new_cost_per_unit: number; shipping_cost: number }[] = [];
  const errors: { packaging_item_id: string; error: string }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const current = byId.get(line.packaging_item_id)!;
    const quantity = Number(line.quantity);
    const purchaseCost = Number(line.purchase_cost);
    const shippingCost = shippingByLine[i];

    const { landedCostPerUnit, newStock, newCostPerUnit } = computeReceivedAdjustment({
      currentStock: Number(current.stock_quantity ?? 0),
      currentCostPerUnit: current.unit_cost != null ? Number(current.unit_cost) : null,
      quantity,
      purchaseCost,
      shippingCost,
    });

    const { error: adjErr } = await supabase.from("packaging_stock_adjustments").insert({
      packaging_item_id: line.packaging_item_id,
      type: "received",
      quantity,
      note: null,
      cost_per_unit: purchaseCost,
      shipping_cost: shippingCost > 0 ? shippingCost : null,
      total_value_change: quantity * landedCostPerUnit,
    });
    if (adjErr) { errors.push({ packaging_item_id: line.packaging_item_id, error: adjErr.message }); continue; }

    const { error: updErr } = await supabase
      .from("packaging_items")
      .update({ stock_quantity: newStock, unit_cost: newCostPerUnit })
      .eq("id", line.packaging_item_id);
    if (updErr) { errors.push({ packaging_item_id: line.packaging_item_id, error: updErr.message }); continue; }

    results.push({
      packaging_item_id: line.packaging_item_id,
      new_stock: newStock,
      new_cost_per_unit: newCostPerUnit,
      shipping_cost: shippingCost,
    });
  }

  return NextResponse.json({ results, errors }, { status: errors.length === 0 ? 201 : 207 });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run app/api/production/packaging-adjustments/bulk/route.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add app/api/production/packaging-adjustments/bulk/route.ts app/api/production/packaging-adjustments/bulk/route.test.ts
git commit -m "$(cat <<'EOF'
feat(production): add bulk received-adjustment route for packaging

Mirrors the ingredients bulk route; packaging_items has no unit
column so freight is split by raw received quantity across lines.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `BulkReceiveModal` UI component

**Files:**
- Create: `app/production/components/BulkReceiveModal.tsx`

**Interfaces:**
- Consumes (Task 1): `allocateFreightByWeight` (client-side preview only).
- Consumes: `Modal`, `Field`, `ModalActions` from `./shared`; `fmtUsd` from `@/lib/utils/formatting`.
- Produces:
  ```ts
  export interface BulkReceiveItem {
    id: string;
    name: string;
    unit: string | null; // null for packaging (no unit column)
  }
  export interface BulkReceiveModalProps {
    itemType: "ingredient" | "packaging";
    items: BulkReceiveItem[];
    onClose: () => void;
    onDone: () => Promise<void>;
  }
  export default function BulkReceiveModal(props: BulkReceiveModalProps): JSX.Element;
  ```
  POSTs to `/api/production/stock-adjustments/bulk` (Task 3) when `itemType === "ingredient"`, or
  `/api/production/packaging-adjustments/bulk` (Task 4) when `itemType === "packaging"`.

- [ ] **Step 1: Implement**

```tsx
// app/production/components/BulkReceiveModal.tsx
"use client";

import { useState } from "react";
import { Modal, Field, ModalActions } from "./shared";
import { allocateFreightByWeight } from "@/lib/production/freightAllocation";
import { fmtUsd } from "@/lib/utils/formatting";

export interface BulkReceiveItem {
  id: string;
  name: string;
  unit: string | null;
}

export interface BulkReceiveModalProps {
  itemType: "ingredient" | "packaging";
  items: BulkReceiveItem[];
  onClose: () => void;
  onDone: () => Promise<void>;
}

interface Row {
  itemId: string;
  quantity: string;
  purchaseCost: string;
}

const EMPTY_ROW: Row = { itemId: "", quantity: "", purchaseCost: "" };

export default function BulkReceiveModal({ itemType, items, onClose, onDone }: BulkReceiveModalProps) {
  const [rows, setRows] = useState<Row[]>([{ ...EMPTY_ROW }]);
  const [freightTotal, setFreightTotal] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const itemsById = new Map(items.map((it) => [it.id, it]));
  const chosenIds = new Set(rows.map((r) => r.itemId).filter(Boolean));

  function addRow() {
    setRows((rs) => [...rs, { ...EMPTY_ROW }]);
  }
  function removeRow(idx: number) {
    setRows((rs) => (rs.length === 1 ? rs : rs.filter((_, i) => i !== idx)));
  }
  function updateRow(idx: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }

  const freightNum = parseFloat(freightTotal) || 0;
  const previewShipping = allocateFreightByWeight(
    rows.map((r) => ({
      unit: itemType === "ingredient" ? itemsById.get(r.itemId)?.unit ?? "" : "",
      quantity: parseFloat(r.quantity) || 0,
    })),
    freightNum
  );

  const rowsValid =
    rows.length > 0 &&
    chosenIds.size === rows.length &&
    rows.every((r) => r.itemId && parseFloat(r.quantity) > 0 && parseFloat(r.purchaseCost) > 0);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!rowsValid) return;
    setSubmitting(true);
    setError(null);
    try {
      const idKey = itemType === "ingredient" ? "ingredient_id" : "packaging_item_id";
      const endpoint =
        itemType === "ingredient"
          ? "/api/production/stock-adjustments/bulk"
          : "/api/production/packaging-adjustments/bulk";
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lines: rows.map((r) => ({
            [idKey]: r.itemId,
            quantity: parseFloat(r.quantity),
            purchase_cost: parseFloat(r.purchaseCost),
          })),
          freight_total: freightNum,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Bulk receive failed");
      if (Array.isArray(json.errors) && json.errors.length > 0) {
        throw new Error(json.errors.map((e: { error: string }) => e.error).join("; "));
      }
      await onDone();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title={`Bulk Receive — ${itemType === "ingredient" ? "Ingredients" : "Packaging"}`}
      onClose={onClose}
      extraWide
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface/50 text-left">
                <th className="px-3 py-2 text-xs font-medium text-muted">Item</th>
                <th className="px-3 py-2 text-xs font-medium text-muted text-right">Quantity</th>
                <th className="px-3 py-2 text-xs font-medium text-muted text-right">Purchase Cost ($/unit)</th>
                <th className="px-3 py-2 text-xs font-medium text-muted text-right">Allocated Freight</th>
                <th className="px-3 py-2 text-xs font-medium text-muted"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, idx) => (
                <tr key={idx} className="border-b border-line/60 last:border-0">
                  <td className="px-2 py-1.5">
                    <select
                      className="inp text-sm w-full"
                      value={row.itemId}
                      onChange={(e) => updateRow(idx, { itemId: e.target.value })}
                    >
                      <option value="">— select —</option>
                      {items
                        .filter((it) => it.id === row.itemId || !chosenIds.has(it.id))
                        .map((it) => (
                          <option key={it.id} value={it.id}>{it.name}</option>
                        ))}
                    </select>
                  </td>
                  <td className="px-2 py-1.5">
                    <input
                      type="number" step="0.001" min="0" className="inp text-sm w-full text-right tabular-nums"
                      placeholder="0" value={row.quantity}
                      onChange={(e) => updateRow(idx, { quantity: e.target.value })}
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <input
                      type="number" step="0.01" min="0" className="inp text-sm w-full text-right tabular-nums"
                      placeholder="0.00" value={row.purchaseCost}
                      onChange={(e) => updateRow(idx, { purchaseCost: e.target.value })}
                    />
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-secondary">
                    {fmtUsd(previewShipping[idx] ?? 0)}
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <button
                      type="button" onClick={() => removeRow(idx)} disabled={rows.length === 1}
                      className="text-xs text-faint hover:text-danger transition-colors disabled:opacity-30"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <button
          type="button" onClick={addRow}
          className="text-xs text-accent-emphasis hover:text-accent transition-colors font-medium"
        >
          + Add item
        </button>

        <Field label="Total Freight / Shared Charges ($)">
          <input
            type="number" step="0.01" min="0" className="inp" placeholder="0.00"
            value={freightTotal} onChange={(e) => setFreightTotal(e.target.value)}
          />
          <p className="text-xs mt-1 text-muted">
            Split across the items above proportional to weight (derived from each item&apos;s unit where possible).
          </p>
        </Field>

        {error && <p className="text-xs text-danger">{error}</p>}

        <ModalActions submitting={submitting} onCancel={onClose} label="Record Bulk Receive" disabled={!rowsValid} />
      </form>
    </Modal>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors introduced by this file.

- [ ] **Step 3: Commit**

```bash
git add app/production/components/BulkReceiveModal.tsx
git commit -m "$(cat <<'EOF'
feat(production): add BulkReceiveModal component

Generic multi-row "received" form (item picker, quantity, purchase
cost per row, one shared freight total) reused by both the
Ingredients and Packaging tabs; posts to the matching /bulk route.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Wire "Bulk Receive" into IngredientsTab and PackagingTab

**Files:**
- Modify: `app/production/components/IngredientsTab.tsx:1-17,363-364,572-587,924-925`
- Modify: `app/production/components/PackagingTab.tsx:1-16,79-96,207-222,476-479`

**Interfaces:**
- Consumes (Task 5): `BulkReceiveModal`, `{ itemType, items, onClose, onDone }`.

- [ ] **Step 1: `IngredientsTab.tsx` — import and state**

Add to the import block (after the existing `import { Modal, Field, ModalActions } from "./shared";`
on line 7):

```ts
import BulkReceiveModal from "./BulkReceiveModal";
```

Add alongside the other `useState` declarations near line 363-364:

```ts
  const [showBulkModal, setShowBulkModal] = useState(false);
  const [showBulkReceive, setShowBulkReceive] = useState(false);
  const [showIngModal, setShowIngModal] = useState(false);
```

(only the new `showBulkReceive` line is added; the other two already exist there.)

- [ ] **Step 2: `IngredientsTab.tsx` — button**

In the action-buttons `<div className="flex gap-2 shrink-0">` block (currently lines 572-587),
add a "Bulk Receive" button next to "Bulk Edit":

```tsx
        <div className="flex gap-2 shrink-0">
          {bulkEditMode ? (
            <>
              <button onClick={() => setBulkEditMode(false)} className="btn-secondary" disabled={bulkSaving}>Cancel</button>
              <button onClick={saveBulkEdit} className="btn-primary" disabled={bulkSaving}>
                {bulkSaving ? "Saving…" : "Save All"}
              </button>
            </>
          ) : (
            <>
              <button onClick={enterBulkEdit} className="btn-secondary" disabled={ingredients.length === 0}>Bulk Edit</button>
              <button onClick={() => setShowBulkReceive(true)} className="btn-secondary" disabled={ingredients.length === 0}>Bulk Receive</button>
              <button onClick={() => setShowBulkModal(true)} className="btn-primary">↑ Bulk Upload</button>
              <button onClick={openNew} className="btn-primary">+ New Ingredient</button>
            </>
          )}
        </div>
```

- [ ] **Step 3: `IngredientsTab.tsx` — render the modal**

Add right after the existing "Bulk upload modal" block (after line 730, before the "Ingredient
modal" block):

```tsx
      {showBulkReceive && (
        <BulkReceiveModal
          itemType="ingredient"
          items={ingredients.map((ing) => ({ id: ing.id, name: ing.name, unit: ing.unit }))}
          onClose={() => setShowBulkReceive(false)}
          onDone={async () => {
            setShowBulkReceive(false);
            await Promise.all([onRefresh(), onAdjustmentsRefresh()]);
          }}
        />
      )}
```

- [ ] **Step 4: `PackagingTab.tsx` — import and state**

Add to the import block (after `import { Modal, Field, ModalActions } from "./shared";` on line 7):

```ts
import BulkReceiveModal from "./BulkReceiveModal";
```

Add alongside the other `useState` declarations near line 79-82:

```ts
  const [showModal, setShowModal] = useState(false);
  const [showBulkReceive, setShowBulkReceive] = useState(false);
```

(only the new `showBulkReceive` line is added; `showModal` already exists there.)

- [ ] **Step 5: `PackagingTab.tsx` — button**

Replace the current single-button header block (lines 207-222, the `<div className="flex
items-center justify-between...">` through its closing `</div>` — leave the `{/* Search + type
filter + Add Item inline */}` comment on line 206 above it untouched):

```tsx
      <div className="flex items-center justify-between gap-2 mb-4 flex-wrap">
        <FilterBar activeCount={activeCount} onClear={reset}>
          <SearchInput
            value={search.q ?? ""}
            onChange={(v) => setSearch("q", v)}
            placeholder="Search packaging…"
          />
          <FilterChips
            label="Type"
            options={TYPE_OPTIONS}
            value={filters.type ?? []}
            onChange={(v) => setFilter("type", v)}
          />
        </FilterBar>
        <div className="flex gap-2 shrink-0">
          <button onClick={() => setShowBulkReceive(true)} className="btn-secondary" disabled={packaging.length === 0}>Bulk Receive</button>
          <button onClick={openNew} className="btn-primary">+ Add Item</button>
        </div>
      </div>
```

- [ ] **Step 6: `PackagingTab.tsx` — render the modal**

Add right after the existing "Adjustment modal" block (after the current closing `)}` on line 476,
before the final `</>` on line 477-478):

```tsx
      {showBulkReceive && (
        <BulkReceiveModal
          itemType="packaging"
          items={packaging.map((p) => ({ id: p.id, name: p.name, unit: null }))}
          onClose={() => setShowBulkReceive(false)}
          onDone={async () => {
            setShowBulkReceive(false);
            await onRefresh();
          }}
        />
      )}
```

- [ ] **Step 7: Verify full suite**

Run: `npm run verify`
Expected: lint, typecheck, and all tests pass — no regressions from Task 2's refactor, plus all
21 new tests from Tasks 1-4 (7 + 3 + 6 + 5).

- [ ] **Step 8: Commit**

```bash
git add app/production/components/IngredientsTab.tsx app/production/components/PackagingTab.tsx
git commit -m "$(cat <<'EOF'
feat(production): wire Bulk Receive into Ingredients and Packaging tabs

Adds a "Bulk Receive" button next to the existing per-row Adjust
entry point on both tabs, opening BulkReceiveModal scoped to that
tab's item type.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Post-implementation verification (not a task — do this after Task 6)

Per repo convention for UI changes: start the dev server, open the Production → Ingredients tab,
click "Bulk Receive", add 2-3 rows with different units (e.g. one "lb" item + one "oz" item),
enter a freight total, confirm the per-row "Allocated Freight" preview updates live and looks
weight-proportional, submit, and confirm the table + Stock Adjustments history reflect the new
stock/cost. Repeat on the Packaging tab (freight there should split by raw quantity, since
packaging has no unit). Check both the empty-item-list case (button disabled) and a submit
validation error (e.g. two rows pointing at the same item) surface correctly.
