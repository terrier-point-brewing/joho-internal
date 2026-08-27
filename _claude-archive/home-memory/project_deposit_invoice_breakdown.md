---
name: project_deposit_invoice_breakdown
description: 2026-07-09 — frozen deposit-invoice ingredient breakdown (PR
metadata: 
  node_type: memory
  type: project
  originSessionId: c51a61cd-87ff-4d96-b4dc-cc9c5af9cc4b
---

Deposit invoices now persist a frozen per-ingredient breakdown so the ingredient prices/quantities behind a deposit stay referenceable after prices change. Shipped as **PR #128** (branch `claude/deposit-invoice-ingredient-breakdown-fe63af`), built via subagent-driven-development. 759 tests pass, tsc/lint clean, whole-branch review clean.

**Architecture:**
- New table `deposit_invoice_ingredients` (child of finance `invoices` row, admin-only RLS, audit trigger). One table; `line_total_cents` stored pre-scaled (largest-remainder) so it sums exactly to `invoices.total_cents` ("reconcile to total", per user decision). No provenance flags.
- Write path: `lib/production/depositBreakdown.ts::snapshotDepositBreakdown` called on deposit `generate` (best-effort try/catch) + `mark_paid` in `app/api/production/allocations/[id]/invoice/route.ts`. `DepositCalculation.breakdown` gained `ingredient_id`.
- Backfill: `lib/production/depositReconstruction.ts` replays `audit_log` for point-in-time cost/qty. Membership is audit-driven (recipe edits do full delete+re-insert of `recipe_ingredients`), handles delete-after/edit-churn/pre-audit rows. Exposed as admin route `POST /api/production/deposit-invoices/backfill` (dry-run default; `{apply:true}` writes).
- Read/UI: `GET /api/production/deposit-invoices` + Brewing → Deposit Invoices subtab (`DepositInvoicesTab.tsx`), mirrors Export Invoices.

**PENDING manual prod steps (gated on user OK + backup, per [[feedback_prod_db_migration_authorization]]):**
1. Apply `supabase/migrations/20260709_deposit_invoice_ingredients.sql`.
2. Dry-run backfill route `{}` (as admin) → review `results[]` sum_cents vs total_cents.
3. Apply backfill `{apply:true}`.

**Known out-of-scope:** pre-existing `batch_number` (TEXT) mistyped as `number` in `ExportInvoicesTab.tsx:27` and `app/production/types.ts:319,412`; GET route's non-admin roles inert under invoices RLS (inherited from export sibling). Relates to [[project_three_channel_invoicing]].
