---
name: project_draft_restock_phantom_export
description: "2026-07-19 draft-restock keg swaps always book barrel excise via batch-less \"phantom\" export; PR"
metadata: 
  node_type: memory
  type: project
  originSessionId: 0395bbf2-ae1d-49f2-863b-86f17ce2b3a0
  modified: 2026-07-20T06:31:06.062Z
---

2026-07-19: Draft-restock keg swaps (taproom `draft_swap`) now ALWAYS book barrel excise, even when cold storage has no stock to deduct. Previously the excise `export_transactions` row was a strict side-effect of a successful cold-storage depletion, so an empty cold storage silently dropped the export → **understated B-C-710 excise liability**. **PR #231 MERGED 2026-07-20** (squash `9fe4c2e`); final Opus review was READY TO MERGE (0 Critical/Important). Worktree + branch cleaned up.

**Behavior:** on any shortfall, `recordTaproomConsumption` writes a batch-less "phantom" export via `writePhantomExport` (`is_phantom=true`, `batch_id NULL`, `channel taproom`, `status paid`) with NO cold-storage depletion; partial stock = physical rows (deplete) + phantom for the remainder (volumes sum to full swap). Idempotency (`source_ref` recorded-qty) includes phantom rows. Recount fires for phantom-only swaps; shrinkage capture stays tied to physical `recordedQty`. Each open phantom = an acknowledgeable alert (Export Bay "N swaps without cold-storage stock"): **Reconcile** = targeted single-batch depletion (`depleteColdStorageInventory({batchId})`, never negative) + backfill `batch_id` + `alert_acknowledged_at` (keeps `is_phantom` — permanent origin marker); **Dismiss** = acknowledge only. Daily digest email via cron (best-effort, `alert_emailed_at` dedupe). Swap-keg selector (`DraftStatsTab`) repointed to ALL recipe keg variations regardless of stock (`recipe_packaging_variations?recipe_id=`).

**Migration `20260806_export_transactions_phantom.sql` APPLIED to prod 2026-07-20** (renumbered from 20260805 to avoid collision with the merged `20260805_expenses_qb_sync_status.sql` — watch for this: two features in flight both grabbed the next date prefix) — drops `export_transactions.batch_id NOT NULL`; adds `is_phantom`/`alert_acknowledged_at`/`alert_emailed_at` + partial index. Code tolerates absence at READ time, but phantom WRITES need the columns. Non-CONCURRENT index (brief write lock on apply). Browser E2E never verified (no app credentials).

**Non-obvious facts confirmed during build (durable):**
- `export_transactions` stores NO `variation_id` — resolve via `recipe_packaging_variations` → `packaging_variations` on `(recipe_id, container_id = packaging_item_id, format = packaging_format)`. Shared helper `resolveSwapVariationId` in `phantomExportAlerts.ts`. Same precedent as `exportInvoicePreview.ts`.
- There is NO `shipments` table — `export_transactions.shipment_id` is a caller-generated grouping UUID (`crypto.randomUUID()` in `writeColdStorageShipment`), not an FK.
- Repo has NO generated Supabase types — clients (`lib/supabase/*`) are untyped (no `Database` generic, no gen script). Migrations are pure SQL; no type regeneration step.
- `batch_id`-nullable audit (Task 2) confirmed every `export_transactions` consumer is null-tolerant (B-C-710 `calc.ts` reads `volume_bbl`/taxes directly; exports listing uses LEFT embed). Regression tests added in `fetchSources.test.ts` + `calc.test.ts`.
- KNOWN (reviewed, non-blocking): a phantom-only swap is tallied as `skipped` in the cron summary (reporting only; surfaced via `short_stock` discrepancy; codified by an existing test — left as-is).

Related: [[project_beer_excise_bc710_module]] (consumes export_transactions gallons), [[project_unified_draft_pour_consumption]] (draft pour ledger), [[feedback_prod_db_migration_authorization]] (migration is human-gated).
