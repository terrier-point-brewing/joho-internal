---
name: project_packaging_materials_breakdown_and_fee_grouping
description: "2026-07-25 PR #272 MERGED — Packaging Materials cost-breakdown sub-modal, packaging fee lines grouped per recipe × packaging type, frozen materials snapshot table (migration 20260817 PENDING prod apply)"
metadata: 
  node_type: memory
  type: project
  originSessionId: 5441cb05-a5b3-4ed9-bed8-eead4b33747c
  modified: 2026-07-25T16:04:50.166Z
---

2026-07-25, **PR #272 MERGED (squash `8ecddb8`); worktree + branch cleaned.** Four changes to Production → Shipments / export invoicing:

1. **Materials breakdown sub-modal** — `computeMaterialBreakdown` (new, in `packagingMaterials.ts`) retains every intermediate; `computeMaterialCost` delegates to it. Preview carries `materialBreakdowns` keyed by line id → "How is this calculated?" opens `PackagingMaterialsBreakdownModal`.
2. **Packaging fee lines grouped** by (recipe × packaging item × mapping format) via new `groupPackagingFeeRows`, NOT per transaction.
3. Summary-row number notation via `lib/format.ts` helpers.
4. **Frozen snapshot** — new table `export_invoice_material_components` + `materialBreakdownSnapshot.ts`, mirrors [[project_deposit_invoice_breakdown]]'s `deposit_invoice_ingredients`.

**⚠️ Migration `20260817_export_invoice_material_components.sql` PENDING prod apply.** The export-invoices GET route HARD-EMBEDS the new table (house pattern, same as the deposit route) → `/api/production/export/invoices` 500s with PGRST200 until applied. Apply before/with deploy, not after. See [[project_migration_drift_brew_activities]].

**Why one physical shipment produced multiple fee lines:** a shipment drawn from several commitments is stored as SEVERAL `export_transactions` rows with fractional quantities (prod case: 16 half-kegs of Pumpkin Ale = 5.8034 + 10.1966). The allocation split is a ledger concern, not a billing one. Grouping also fixed a latent case/loose bug: 2.5 + 2.5 cases billed as 2 cases + 12 loose *twice* instead of 5 whole cases. Sums are rounded to 6 decimals to clear float dust.

**Deliberate departures from the deposit-table pattern** (don't "fix" these):
- Rows are NOT scaled so they sum to `invoices.total_cents`. The user can edit the materials line before generating, so a mismatch vs `invoice_line_items` is meaningful signal. `invoice_line_items` stays authoritative.
- `unit_cost` stays NULL when unset — "billed $0 because unpriced" ≠ "costs nothing".

**Durable gotcha — nested modals:** the shared `app/components/ui/Modal.tsx` registered a `document` Escape listener per instance, so Escape on a nested modal closed BOTH (parent lost unsaved edits). Fixed with a module-level modal stack; only the topmost responds. Any future nested modal depends on this.

Snapshot is recomputed SERVER-side at generate/record/mark_paid (`computeMaterialBreakdownsForTransactions`), never trusting the client preview payload. No backfill for existing invoices — historical unit costs are exactly what's unrecoverable.

Green: 1973 tests, build compiles. **Browser E2E UNRUN** (app is login-gated; agent cannot enter credentials). Test case: Argus Jul 22 Pumpkin Ale → should show ONE "Packaging Fee — Pumpkin Ale" at qty 16.
