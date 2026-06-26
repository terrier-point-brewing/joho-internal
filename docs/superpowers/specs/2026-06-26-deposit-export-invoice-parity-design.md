# Spec 8: Deposit Invoice ↔ Export Invoice Parity + Strict Packaging-Preference Wiring

## Context

The deposit-invoice flow (Commitment → Batch → Allocation Plan → Deposit Invoice → Paid → Locked) predates this roadmap and was never formally speced. Spec 6 (merged, PR #24) built a parallel, more capable invoicing flow for Export Transactions: multi-line invoices, `export_service_mappings` (default + per-partner Square item overrides), per-partner/global net-terms due dates, and generate/send/sync actions. The two flows have since diverged in capability and have a real, confirmed gap: nothing anywhere transitions `export_transactions.status` from `'unpaid'` to `'paid'` — the "Paid" badge in the export UI is dead code.

Separately, Specs 9/10/11 built `packaging_variations` (a strictly-defined container + format + component-slot entity) and wired it into Brewing/cold-storage (Spec 10) and Export Settings' fee mapping (Spec 11) under a user-confirmed principle: **once packaging variations are declared for a recipe via `recipe_packaging_variations`, they are the only valid choices downstream — no ad-hoc component assembly, no free-text entry.** `commitment_packaging_preferences` (Intake/Commitments) was the one remaining consumer never migrated to this principle.

This spec does both: brings deposit invoicing to parity with export invoicing (reusing Spec 6/7's shapes rather than duplicating them), and rekeys `commitment_packaging_preferences` to the strict variation model.

All design decisions below were individually approved during this project's brainstorming sessions; this doc consolidates them into one spec for planning.

## Part A — Invoice module merge

`lib/square/deposit-invoices.ts` and `lib/square/export-invoices.ts` merge into one `lib/square/square-invoices.ts`. The generalized multi-line creator (export's `createExportInvoice`/`InvoiceLineItemDraft[]` shape) becomes the only invoice-creation path; deposits become a 1-line-item call into it. `publishInvoice`/`getInvoiceStatus`/`cancelInvoice`/`reviseInvoice` become shared generic functions used by both flows. `calculateIngredientDeposit` (pure math — recipe ingredient cost × volume × percentage, no Square calls) stays as-is, just feeds one `InvoiceLineItemDraft` instead of calling a deposit-specific creator.

The export module's line-item builder already always sets `base_price_money` regardless of whether a `catalog_object_id` is attached (verified in current code), so a Square item with no preset price (Ingredient Deposit) paired with our computed price already works natively in the merged shape — no extra work needed there.

## Part B — Schema

- `export_service_mappings` **renames to `invoice_item_mappings`** (no longer export-specific once it covers deposits too). All existing columns/constraints carry over unchanged: `service_type`, `partner_id`, `packaging_item_id`, `square_catalog_item_id`, `square_catalog_variation_id`, `square_catalog_discount_id`, the `unique nulls not distinct (service_type, partner_id, packaging_item_id)` constraint.
- `invoice_item_mappings.service_type` check constraint gains `'ingredient_deposit'`, same shape as `keg_cleaning`/`forklift`: `packaging_item_id` always NULL, `square_catalog_item_id` + `square_catalog_variation_id` required, `square_catalog_discount_id` NULL. Keyed by `(service_type, partner_id)` only — default (`partner_id` NULL) + per-partner override, no packaging-item dimension (deposit amount is a single computed dollar figure, not packaging-dependent).
- New `contract_brewing_partners.deposit_net_terms_days` (nullable int, per-partner override) — a distinct column from `export_net_terms_days`, since deposit and export due dates are different business concepts even though both are "days from invoice date."
- New `system_settings.deposit_invoice_due_days` (int, global default), parallel to `export_invoice_due_days`.
- `batch_allocations` needs no new columns. `export_transactions.status` already has `'paid'` as a valid value, just never reached — no schema change, only wiring (Part C).

## Part C — API routes

- `app/api/production/allocations/[id]/invoice/route.ts`: `generate` builds one `InvoiceLineItemDraft`, resolving the Square item via `invoice_item_mappings` (partner override → default) instead of the removed `findIngredientDepositVariationId`/env-var lookup. Due date now computed from `deposit_net_terms_days` (partner override) → `deposit_invoice_due_days` (global default), replacing the current `batch.expected_delivery_date ?? batch.planned_brew_date` logic. `send` calls the shared `publishInvoice()`. `sync` gains a lighter post-generate "did the draft actually get created" check, in addition to its existing paid-status check.
- `app/api/production/export/invoice/route.ts`: **stops auto-publishing on creation** — confirmed via code read that this is a real, accidental gap (the route currently publishes immediately after creating the draft), not a deliberate design choice, and no code anywhere transitions `export_transactions.status` to `'paid'`. `generate` now only creates the DRAFT. The same route gains `send` and `sync` actions (mirroring deposit's exact action-param shape), addressed via the already-known `square_invoice_id` stored on `export_transactions` rows rather than re-deriving the transaction grouping. `sync` flips `export_transactions.status` to `'paid'` when Square confirms payment — closing the dead-badge gap.
- `findIngredientDepositVariationId` (`lib/square/catalog.ts`) and the `SQUARE_INGREDIENT_DEPOSIT_VARIATION_ID` env var are removed as dead code once `invoice_item_mappings` owns this lookup.
- No cron jobs exist anywhere in this repo and this spec does not add any — all sync remains manual-button-triggered.

## Part D — UI

- New top-level `PRODUCTION_NAV` entry: `{ href: "/production/settings", label: "Settings" }` (sibling to Intake/Brewing/Export/Recipes/Inventory/Partners), with its own sub-nav (mirroring `BREWING_NAV`'s pattern) for **Deposit Settings** (`/production/settings/deposits`) and **Export Settings** (`/production/settings/export`).
- `ExportSettingsPanel.tsx` moves under this new route tree (still `scope="full"` for Export Settings, still mirrored at Finance > Settings > excise-tax with `scope="excise-only"` — just repoint that page's import). It gains an `ingredient_deposit` mapping UI section — but per prior explicit decision, that section's home is the **Deposit Settings** sub-tab (grouped with `deposit_net_terms_days`), not Export Settings, even though both are now `invoice_item_mappings` rows.
- New `DepositSettingsPanel.tsx` (or a new `scope` on `ExportSettingsPanel`) for Deposit Settings: `deposit_net_terms_days` global + per-partner override, plus the `ingredient_deposit` mapping section.
- `ExportTab.tsx` loses its internal `"settings"` tab from `TOP_TABS` — Export Bay / Taproom / Export Transactions remain.
- `ExportTransactionsTab.tsx` gains "Send" and "Sync" buttons/states per invoiced-but-unsent / sent-but-unpaid groups, mirroring `BatchLogTab.tsx`'s existing pattern. `BatchLogTab.tsx`/`DepositInvoiceModal.tsx` need no new UI beyond what exists — same buttons, now backed by the merged module + new due-date logic.

## Part E — Bug-fix bundle (`ExportSettingsPanel.tsx`)

1. **Excise Tax Rates can't be edited** — `ExciseTaxRateRow` currently only has edit controls for `square_catalog_item_id`/`square_catalog_variation_id`/`is_active`; `name`, `receiving_party`, `unit`, `rate_usd` are display-only. The PATCH route already supports updating all four. Fix: add edit controls for all four missing fields.
2. **No mapping section lets you add a partner-specific override** — `SimpleServiceSection` and `BulkDiscountSection` both hardcode `partner_id: null` with no partner-picker UI; `PackagingFeeSection` displays existing partner overrides but has no control to create a new one. The PUT route already accepts and upserts non-null `partner_id` correctly — this is purely a missing UI control. Fix: add a partner-select + "add override" control to every mapping section.
3. ~~Packaging Fee mapping fragmentation~~ — resolved by Spec 11 (merged), not part of this spec.

## Part F — `commitment_packaging_preferences` strict consumption

`commitment_packaging_preferences` is the one remaining consumer of the old ad-hoc/free-pick packaging model, never migrated when Specs 9-11 established the strict-variation principle. This part rekeys it to match, reusing Spec 10's exact pattern (`TransferModal.tsx`'s pick-from-declared-list UI, `packaging_variations.total_volume_fl_oz` as the volume source of truth) rather than inventing a parallel one.

**Out of scope, explicitly deferred**: packaging cost is *not* added to the deposit-invoice calculation as part of this spec. Packaging is typically not finalized until later in the production cycle (it fluctuates more than ingredient cost), so cost is expected to be incorporated at the **export invoice** end in a future spec, not here. `calculateIngredientDeposit` is untouched by Part F.

### Schema

New migration: `commitment_packaging_preferences` drops `packaging_item_id`, gains `variation_id uuid not null references packaging_variations(id) on delete restrict`. `qty` column unchanged. No backfill — this table has no cost-calc consumer today and live data is low-stakes, matching the precedent Spec 10 set for `cold_storage_inventory`.

### API

`app/api/production/contract-requests/route.ts`: payload shape changes from `{packaging_item_id, qty}` to `{variation_id, qty}` on both the write path (the `parsePackaging`-style helper and the insert into `commitment_packaging_preferences`) and the read/join path (the select needs to join `packaging_variations` instead of `packaging_items`, mirroring the existing `RecipePackagingVariation`/`PackagingVariation` joined shape used elsewhere).

### UI

`app/production/components/intake/CommitmentsTab.tsx`'s `CommitmentModal`:
- Replace the free-pick `usePackagingQuery()` + `packaging_item_id` select with `useRecipePackagingVariationsQuery()` filtered to `form.recipe_id`, split into `kegVariations`/`canVariations` groups — same pattern as `TransferModal.tsx`'s `recipeVariations`/`kegVariations`/`canVariations`.
- `rowBbl()` switches from `item.volume_fl_oz` to `variation.total_volume_fl_oz`, matching `TransferModal.tsx`'s `drawBbl` calculation.
- `recipe_id` is already selected before packaging rows are added in this form, so no ordering/UX problem on initial entry. New edge case (not present in `TransferModal.tsx`, which derives tank and recipe together): if the user changes `recipe_id` after adding packaging rows, any selected `variation_id` not in the new recipe's declared set must be cleared — add a `useEffect` (or equivalent) that filters `form.packaging` rows against the newly-filtered `recipeVariations` whenever `form.recipe_id` changes, clearing `variation_id` (not removing the row) on rows that no longer match, mirroring how the user would need to re-pick.
- `PackagingRow` interface and `EMPTY_PACKAGING_ROW` constant rename `packaging_item_id` → `variation_id`.

### Types

`app/production/types.ts`: `CommitmentPackagingPreference.packaging_item_id` → `variation_id`, gains an optional joined `packaging_variations?: PackagingVariation | null` field, matching `RecipePackagingVariation`'s shape.

## Out of scope (explicitly deferred)

- Packaging-cost-on-invoice (Part F) — future spec, once export invoicing's own packaging-cost handling is designed.
- Cron-based auto-sync — explicitly deferred to a later, separate effort (no cron jobs exist anywhere in this repo today).
- Any further consolidation of `packaging_items`/`packaging_variations` beyond what Specs 9-11 already did.

## Testing

No test runner exists in this repo (Roadmap Lesson #1). Verification is `npm run lint` + `npm run build` + per-task code review + a direct REST check against the live Supabase project (`drlsazatrcrdwaihjmex`) for the migration. Manual checks: deposit invoice generate/send/sync end-to-end against a real (or sandboxed) Square invoice if any unpaid allocation exists; export invoice generate no longer auto-publishes, and sync correctly flips status to `'paid'` once a real payment is confirmed; Commitments modal's packaging rows only ever offer the selected recipe's declared variations, and clear correctly if the recipe selection changes.
