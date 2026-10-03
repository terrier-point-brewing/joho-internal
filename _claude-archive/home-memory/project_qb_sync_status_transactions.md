---
name: project_qb_sync_status_transactions
description: 2026-07-19 QuickBooks sync status captured from Ramp + shown in Transactions; PR #230 MERGED, migration 20260805 APPLIED, worktree cleaned
metadata: 
  node_type: memory
  type: project
  originSessionId: a67d124f-8f21-430d-b7cd-d13efdaf3432
---

**2026-07-19:** Capture Ramp's per-object QuickBooks sync state and surface it in Finance → Transactions (Expenses + Bank Ledger tabs). **PR #230 MERGED** (squash e4b114a); **migration 20260805 APPLIED to prod; worktree/branch cleaned.** Precondition for a future "export to QuickBooks" route that must EXCLUDE objects Ramp already synced (see [[project_ramp_unified_ledger]], [[project_ramp_bill_settlement_dedup]]). OPEN follow-up: build that QB-export route (query `qb_sync_status NOT IN (SYNCED, BILL_AND_PAYMENT_SYNCED)` to emit only what Ramp hasn't pushed); browser E2E never verified (no app credentials).

**Verified live (read-only probe):** Ramp's native QBO integration is `connection_type: DIRECT` (GET /accounting/connection → `remote_provider_name: "QuickBooks"`) and DOES surface sync state over the developer API:
- `/transactions`: `sync_status` ∈ NOT_SYNC_READY | SYNC_READY | SYNCED, plus `synced_at` (ISO ts). Server-side `?sync_status=SYNCED` filter works. (~68/100 recent txns SYNCED.)
- `/bills`: `sync_status` ∈ NOT_SYNCED | BILL_SYNCED | BILL_AND_PAYMENT_SYNCED, plus `remote_id` (the QB object id) + `enable_accounting_sync`.
- `/banking/syncable-transactions`: `sync_status` present (often 0 rows in a given window).
- Do NOT call `POST /accounting/syncs` — Ramp's native integration owns the sync; posting our own results would corrupt its Accounting View.

**Data model:** three nullable cols on BOTH `expenses` + `ramp_bank_ledger`: `qb_sync_status` (raw Ramp value — enums differ per ramp_object, normalized in code), `qb_synced_at`, `qb_remote_id`. Named `qb_*` because `expenses.synced_at` ALREADY EXISTS meaning "when our app last pulled from Ramp" (different concept). Normalizer = `lib/finance/qbSyncStatus.ts` (`normalizeQbSyncStatus`/`qbSyncLabel`); badge colors in `app/finance/lib/categoryColors.ts` (`QB_SYNC_CLS`). Shared UI: `app/finance/transactions/components/QbSyncBadge.tsx`.

**Deploy-ordering note (RESOLVED — migration applied before/at merge):** the two GET routes (`/api/finance/expenses`, `/api/finance/bank-ledger`) `select` the new columns, so the migration had to land in prod before deploy or the tabs 500 on missing columns. Migration has NO backfill — existing rows show `qb_sync_status` NULL (badge = `unknown` = nothing) until a Ramp sync re-upserts them. **PENDING: run one Ramp sync in prod** (Expenses tab "Sync Ramp" button or daily cron) to populate `qb_*` on historical rows.

**Verify:** `npm run verify` green (1683 tests). Spec + plan under docs/superpowers/{specs,plans}/2026-07-19-qb-sync-status-transactions*.
