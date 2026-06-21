# Ad-Hoc Export

**Spec 2c-1 of the Invoicing / Kegging-Canning / Cold Storage / Export feature roadmap:**
1. Cold Storage + Transfer Log schema (Spec 1 — merged)
2. Export Transaction model + batch-completion automation (Spec 2a — merged)
3. Export Bay UI (Spec 2b — merged)
4. **Ad-Hoc Export** (this spec)
5. Allocation adjustment + refund flow (Spec 2c-2) — depends on this spec only loosely (both extend Export Bay, otherwise independent)
6. Export > Commitments unified invoicing — depends on Spec 2a
7. Export Settings + Barrel Excise Tax settings — depends on Spec 2a

## Problem

Spec 2b's Export Bay can only ship against an *existing* `batch_allocations` row. There is no way to ship inventory to a customer/recipe combination that has no allocation at all — a real gap for one-off shipments, bonus product, or any export that was never part of a formal allocation plan. The original feature request calls this "Ad-Hoc Export": pick a customer from a dropdown, ship a quantity, with no target BBL to credit against, plus a warning if that customer actually does have an active allocation for that recipe (so the user doesn't accidentally bypass real allocation tracking by mistake).

## Goals

- Let a user ship cold-storage inventory to any customer/recipe combination, with or without an existing allocation.
- Warn (non-blocking) when the selected customer already has an active allocation for the selected recipe, so accidental ad-hoc shipments that should have gone through the real Ship flow are caught before submission, not after.
- Extract the inventory-depletion and export-transaction-writing logic that Spec 2b's `ship/route.ts` already implements into shared `lib/production/` helpers, so this spec's new endpoint doesn't duplicate that logic — and so any future bug fix to depletion/writing benefits both endpoints at once.

## Non-Goals

- Allocation adjustment or refund (Spec 2c-2) — entirely separate, no shared code with this spec beyond both living in the Export Bay UI.
- Changing the *regular* Ship flow's allocation-crediting behavior — Spec 2b's endpoint keeps its existing external behavior; only its internals get refactored to call the new shared helpers.
- Any new UI for taproom inventory sync — taproom ad-hoc exports just skip the partner/allocation concept entirely, same as the rest of Export Bay treats taproom.

## Architecture

**Three new shared lib files**, extracted from the current `app/api/production/export-bay/ship/route.ts` (read in full while designing this spec — exact line ranges below refer to its current merged state):

- `lib/production/exportBayEquipment.ts` — `getExportBayEquipmentId(supabase: SupabaseClient): Promise<string | null>`. Lifts the Step 4b equipment lookup (lines 146-159) verbatim, returning `null` on no-row instead of constructing a `NextResponse` itself (callers build their own error response — keeps this helper free of Next.js coupling, consistent with `checkAndCompleteBatch`/`computeExciseTaxBreakdown`'s existing style).
- `lib/production/coldStorageDepletion.ts` — two functions:
  - `getAvailableColdStorageQuantity(supabase, { recipeId, packagingItemId, variantLabel }): Promise<number>` — Step 2's availability sum (lines 45-54), minus the rejection response (callers check the returned number themselves).
  - `depleteColdStorageInventory(supabase, { recipeId, packagingItemId, variantLabel, quantity }): Promise<{ batchId: string; depletedQty: number }[]>` — Step 5's FIFO depletion loop (lines 161-173). Since `cold_storage_inventory` has a unique index on `(batch_id, packaging_item_id, variant_label)` (Spec 1), each row already belongs to exactly one batch — the returned array needs no further aggregation by batch.
- `lib/production/exportTransactionWriter.ts` — two functions:
  - `writeExportTransfer(supabase, { batchId, exportBayId, volumeBbl, notes }): Promise<string>` — the `batch_transfers` insert (part of lines 188-201), returns the new row's id.
  - `writeExportTransaction(supabase, { shipmentId, batchId, recipeId, packagingItemId, variantLabel, quantity, volumeBbl, channel, recipientId, recipientName, allocationId, sourceTransferId, notes }): Promise<string>` — the tax-breakdown-then-insert logic (lines 205-244), with `allocationId` now an explicit parameter (the regular Ship flow passes the credited allocation's id; ad-hoc passes `null`). Returns the new `export_transactions` row's id.

**Spec 2b's `ship/route.ts` is refactored** to call these four functions instead of its current inline logic, for the parts that match 1:1 (Steps 2, 4b, 5, and the per-credit write in Steps 6/7). The allocation-fetching and crediting logic (Steps 3-4, the part this spec doesn't need) stays exactly as-is, untouched. This is a refactor of code that went through 3 review rounds in Spec 2b — treated with the same care: the plan must include an explicit regression check re-running the original hand-traces (multi-batch crediting, `creditedQty` reconciliation) against the refactored version, not just trusting that extraction preserves behavior.

**New `POST /api/production/export-bay/ship-adhoc`**:
```ts
interface AdHocShipRequest {
  channel: "taproom" | "distribution" | "contract_brewing";
  partner_id?: string | null;   // required unless channel === "taproom"
  recipient_name?: string | null; // optional, only meaningful for taproom
  recipe_id: string;
  packaging_item_id: string;
  variant_label: string;
  quantity: number;
  notes?: string | null;
}
```
Logic: validate input (400 if `channel !== "taproom"` and `partner_id` is missing) → compute `requestedBbl` from `packaging_items.volume_fl_oz` (same one-line conversion as the regular Ship route) → `getAvailableColdStorageQuantity`, reject (422) if `quantity` exceeds it → `getExportBayEquipmentId`, fail loudly (500) if missing, same as Spec 2b's fix → `depleteColdStorageInventory` → generate one `shipmentId` for the whole request → for each `{ batchId, depletedQty }` returned: convert `depletedQty` back to BBL via the same `volumeFlOz`, call `writeExportTransfer` then `writeExportTransaction` (`allocationId: null`, `recipientId: partner_id ?? null`, `recipientName: recipient_name ?? null`), then `checkAndCompleteBatch(supabase, batchId)`. No `checkAndFulfillCommitment` call.

**New `GET /api/production/export-bay/active-allocation-check?partner_id=&recipe_id=`**: returns `{ hasActiveAllocation: boolean }` — `true` if any `batch_allocations` row exists for that partner (via `brew_batches.recipe_id = recipe_id` join, `channel != 'taproom'`), mirroring the existence-check shape of the regular Ship route's Step 3 query (without the production/exported-volume math — this endpoint only answers "does any allocation exist at all," not "how much remains"). Purely advisory: the ad-hoc endpoint itself never calls or enforces this.

**UI**: a new "+ Ad-Hoc Export" button in `ExportBayTab.tsx`, disabled when `inventory.length === 0` (mirroring the existing per-group Ship button's disabled-when-empty pattern from Spec 2b). Opens a modal with: Channel select; Partner select (only rendered for `distribution`/`contract_brewing`, reusing `useContractPartnersQuery`, the same hook the regular Ship modal and the old retired modal both used); Recipe select (sourced from `inventoryByRecipe`'s keys — the same data already fetched for the left column, not filtered by existing allocations); Packaging variant + Quantity (same pattern as the existing `ShipModal`, sourced from `inventoryByRecipe.get(selectedRecipeId)`); Notes. When a non-taproom partner+recipe pair is selected, the modal calls the new check endpoint and shows a `confirm()` dialog if `hasActiveAllocation` is `true` ("This customer already has an active allocation for this recipe — are you sure you want to ship ad-hoc instead of crediting that allocation?"); declining the confirm cancels the submission, accepting proceeds normally.

## Edge Cases

- **Taproom ad-hoc**: no partner required, no active-allocation check attempted (taproom has no allocation concept in this codebase, consistent with Spec 2b excluding it from the Customer+Recipe grouping).
- **Quantity exceeds inventory**: rejected (422) with the same `requested X, available Y` message shape as the regular Ship endpoint.
- **Refactor regression**: the plan must re-verify the regular Ship endpoint's exact existing behavior post-refactor (same multi-batch crediting trace, same `creditedQty` reconciliation) — extraction must not silently change anything about the allocation-crediting path, which is untouched logic but now calls into the shared helpers for its depletion/writing steps.
- **No commitment/allocation side effects**: ad-hoc exports never write to or read `batch_allocations`/`commitments` beyond the advisory existence check — only `cold_storage_inventory`, `batch_transfers`, `export_transactions`, `export_transaction_taxes`.
- **Declining the confirm dialog**: the form submission is cancelled client-side; no API call is made, no partial state.

## Testing

No test runner exists in this repo (consistent with Specs 1/2a/2b) — verification is `npm run lint` / `npm run build`, per-task code review, and an explicit regression re-trace of the refactored Ship endpoint's pre-existing hand-traces from Spec 2b's Task 4 review (three credited allocations across different/non-adjacent batches, confirming `creditedQty` still reconciles exactly after the extraction).
