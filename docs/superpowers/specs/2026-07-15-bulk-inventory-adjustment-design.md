# Bulk "received" inventory adjustment (ingredients + packaging)

**Date:** 2026-07-15
**Branch:** `claude/bulk-inventory-adjustments-2d65d1`
**Status:** Approved (design), pending implementation plan

## Problem

Ingredients and packaging stock are adjusted one item at a time today
(`app/production/components/IngredientsTab.tsx`, `app/production/components/PackagingTab.tsx` →
`POST /api/production/stock-adjustments` / `POST /api/production/packaging-adjustments`). In
practice a single invoice often bills multiple ingredients or packaging components at once, plus
one shared freight/shipping charge for the whole shipment. Recording that invoice today means N
separate adjustment submissions, each requiring the user to manually guess how much of the total
freight belongs to that one line — tedious and inconsistent.

This adds a bulk "received" flow: pick several existing items, enter each one's received quantity
and purchase cost, enter the invoice's total freight/shared-charges once, and have freight
proportioned across the lines by weight automatically.

## Decisions (locked)

1. **Scope: "received" adjustments only.** Bulk `used`/`waste`/`inventory_count` are out of scope —
   those don't involve shared freight and can already be done one at a time without much friction.
2. **Ingredients and packaging stay separate flows**, matching the existing tab split. No combined
   ingredient+packaging picker.
3. **No new "weight" column on `ingredients` / `packaging_items`.** Weight for proportioning is
   derived per-adjustment from each item's existing free-text `unit` field (see Freight allocation
   below), the same way `purchase_cost`/`shipping_cost` are already entered ad hoc per adjustment
   today rather than stored on the item.
4. **No schema changes at all.** Each line's allocated freight share is written into that line's
   existing `shipping_cost` column on `stock_adjustments` / `packaging_stock_adjustments` — the
   same column the single-item flow already populates from a user-typed value.
5. **No new transaction/RPC machinery.** Bulk submission loops the same per-item
   insert-adjustment-row + update-item-stock logic the single-item routes already use (RPC
   `adjust_ingredient_stock` for ingredients, plain `.update()` for packaging). This matches
   today's risk profile exactly — not worse, not better.

## Freight allocation algorithm (new: `lib/production/freightAllocation.ts`)

Goal: turn each line's `(quantity, unit)` into a comparable `weight`, then split the freight total
across lines proportional to weight, with the split summing exactly to the total (no lost cents).

**Step 1 — unit → weight-per-unit lookup.** Normalize each item's `unit` (trim, lowercase, strip
trailing `.`) and look up a small canonical table of weight units, in ounces per 1 unit:

| normalized unit | oz per unit |
|---|---|
| `oz`, `ounce`, `ounces` | 1 |
| `lb`, `lbs`, `pound`, `pounds`, `#` | 16 |
| `g`, `gram`, `grams` | 0.035274 |
| `kg`, `kilogram`, `kilograms` | 35.274 |

**Step 2 — resolve unmatched units.** For lines whose unit isn't in the table (e.g. "bricks",
"cases"):
- If at least one line in the batch *did* match a known unit, find the **majority matched unit**
  (most frequent normalized unit string among matched lines; ties broken by first occurrence in
  the batch). Unmatched lines are assigned that majority unit's oz-per-unit factor — i.e. "1 brick
  = 1 [majority unit]".
- If **no** line in the batch matched a known unit, every line falls back to a factor of 1 (pure
  quantity-proportional split).

**Step 3 — compute weight and split.** `weight = quantity × factor` per line.
`freight_cents_total = round(freight_total × 100)`. Each line's raw share is
`(weight / sum(weights)) × freight_cents_total`, floored to whole cents; leftover cents from
flooring go to the lines with the largest fractional remainder (ties: lowest line index) — the
same largest-remainder pattern `lib/production/depositBreakdown.ts`'s `buildBreakdownLines` uses
for invoice-line proportioning. Reimplemented locally with a generic `{ weight: number }[]` input
rather than imported, since `buildBreakdownLines`'s types (`ingredient_id`, `quantity_per_bbl`,
...) are deposit-invoice-specific.

Exported shape:
```ts
export interface FreightLineInput {
  unit: string;
  quantity: number;
}
export function allocateFreightByWeight(
  lines: FreightLineInput[],
  freightTotalDollars: number
): number[]; // shipping_cost dollars per line, same length/order as `lines`, sums to freightTotalDollars (to the cent)
```

**Packaging note:** `packaging_items` has no `unit` column at all (only `ingredients` does — confirmed against the
baseline schema). The packaging bulk route therefore always passes an unmatchable sentinel (e.g. `unit: ""`) for
every line, which the algorithm's Step 2 already handles: with zero matched lines in the batch, every line falls
back to `factor = 1`, i.e. freight is split by raw received quantity. No special-casing needed in
`allocateFreightByWeight` itself — this is the existing fallback branch, just always taken for packaging. This is
a known simplification (a 500-lid line and a 10-keg line split freight by count, not true weight) accepted per
"no schema changes" and "simplest solution" — flagged here rather than left implicit.

## Component changes

### New — `lib/production/freightAllocation.ts`
Implements the algorithm above. Pure function, no I/O.

### Shared WAC/landed-cost math — extract from existing single-item routes
`app/api/production/stock-adjustments/route.ts` and `app/api/production/packaging-adjustments/route.ts`
each currently inline the same shape of logic for a `received` adjustment: compute landed
per-unit cost `(purchase_cost*delta + shipping_cost) / delta`, recompute weighted-average
`cost_per_unit`, insert the adjustment row, update the item row. The underlying math is identical for both item types — only the DB write differs (RPC vs plain
`.update()`, different table/column names). Extract the pure calculation into one generic helper,
`lib/production/receivedAdjustment.ts`:
```ts
export function computeReceivedAdjustment(input: {
  currentStock: number;
  currentCostPerUnit: number;
  quantity: number; // delta, > 0
  purchaseCost: number; // $ per unit
  shippingCost: number; // $ total for this line
}): { landedCostPerUnit: number; newStock: number; newCostPerUnit: number };
```
Both the existing single-item routes and the new bulk routes call this function, then handle their
own item-type-specific DB write. Existing single-item routes are refactored to call it instead of
inlining the math, so there's one source of truth. This is a same-behavior refactor, not a behavior
change — existing single-item route tests must still pass unchanged.

### New — `app/api/production/stock-adjustments/bulk/route.ts`
- `POST` body: `{ lines: { ingredient_id: string; quantity: number; purchase_cost: number }[], freight_total: number }`.
- Validate: `lines.length >= 1`, no duplicate `ingredient_id`, every `quantity > 0`, every
  `purchase_cost >= 0`, `freight_total >= 0`.
- Fetch all referenced ingredients in one query (current `stock_quantity`, `cost_per_unit`, `unit`).
- Call `allocateFreightByWeight` with each line's `(unit, quantity)` and `freight_total` →
  per-line `shipping_cost`.
- For each line, run the extracted received-adjustment calculation, insert into
  `stock_adjustments` (same columns the single-item route writes, `type: "received"`), then update
  `ingredients.stock_quantity` (via `adjust_ingredient_stock` RPC) and `cost_per_unit`.
- Role-gated `brewer`, same as the single-item route (`requireRole(["brewer"])`).
- Response: per-line result (new stock, new cost_per_unit, allocated shipping_cost) for the UI
  preview/confirmation.

### New — `app/api/production/packaging-adjustments/bulk/route.ts`
Structurally identical, `packaging_item_id` instead of `ingredient_id`, writes to
`packaging_stock_adjustments` / `packaging_items`, plain `.update()` (no RPC, matching today's
packaging route).

### New — `app/production/components/BulkReceiveModal.tsx`
Generic modal, `itemType: "ingredient" | "packaging"` prop, reused by both tabs:
- Row table: item picker (dropdown of items not already picked in this session), Quantity
  Received, Purchase Cost ($/unit). Add-row / remove-row controls, minimum 1 row.
- Single "Total Freight / Shared Charges ($)" field below the table.
- Live preview column per row: computed allocated freight, landed unit cost, resulting new
  stock/cost_per_unit — mirrors the existing single-item preview panel's client-side math (must
  stay in sync with the server calc; reuse `allocateFreightByWeight` client-side for the live
  preview since it's a pure function with no server dependency).
- Submit → `POST` to the relevant bulk route; on success, closes and invalidates the
  ingredients/packaging query so the table refreshes; on partial/full failure, surfaces the error
  and leaves the modal open (no partial-success UI — see Error handling).

### `app/production/components/IngredientsTab.tsx` / `PackagingTab.tsx`
Add a "Bulk Receive" button next to the existing per-row Adjust entry point, opening
`BulkReceiveModal` with the appropriate `itemType`.

## Error handling

- Client-side validation (empty rows, non-positive quantity, negative cost/freight, duplicate item)
  blocks submission before any request is sent.
- Server-side: same validation, re-checked (never trust the client). On validation failure, no
  rows are written — the whole batch is rejected up front.
- Once past validation, lines are processed sequentially in the existing per-item pattern (matching
  single-item routes' current behavior/risk). If a later line fails after earlier lines already
  wrote (e.g. a race on `stock_quantity`), the response reports which lines succeeded and which
  failed; **no automatic rollback** of already-written lines (consistent with "no new transaction
  machinery" — this is the same partial-failure exposure the single-item routes already have one
  request at a time, just visible across a batch here). The user can re-run a bulk adjustment
  containing only the failed lines.

## Testing

- `lib/production/freightAllocation.test.ts`:
  - All lines matching the same known unit → proportional by quantity.
  - Mixed known units (e.g. lbs + oz) → proportional by true weight, not raw quantity.
  - One unmatched unit among matched lines → treated as majority-unit-equivalent.
  - No lines match any known unit → falls back to raw-quantity proportioning.
  - Majority-unit tie → deterministic (first-occurrence) tie-break.
  - Allocated cents always sum exactly to `round(freightTotalDollars * 100)`.
- `lib/production/receivedAdjustment.test.ts` (the extracted shared calc): landed cost and WAC
  math, covering both the pre-existing single-item cases (regression) and bulk-line cases.
- Route tests for both new `/bulk` endpoints: validation rejects (duplicate item, non-positive
  quantity, negative freight), happy path writes expected adjustment rows + item updates, role gate.
- Existing single-item route tests must still pass unchanged after the shared-calc extraction.
- `npm run verify` green (lint + typecheck + tests); keep `lib/` coverage above the vitest floor.

## Out of scope / non-goals

- Bulk `used` / `waste` / `inventory_count` adjustments.
- Combined ingredient+packaging bulk adjustment in one form.
- Adding a persistent weight column to `ingredients` / `packaging_items`.
- Any DB transaction/rollback guarantee across a multi-line bulk submission beyond what single-item
  adjustments already have today.
- Editing/undoing a bulk adjustment after submission (same as single-item today — corrections are
  a new offsetting adjustment).
