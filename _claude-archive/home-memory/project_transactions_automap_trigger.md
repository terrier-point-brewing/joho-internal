---
name: project_transactions_automap_trigger
description: 2026-07-10 auto-mapping trigger for finance transactions (PR
metadata: 
  node_type: memory
  type: project
  originSessionId: 8fd63642-d899-4959-81b1-96e23d373a6f
---

Finance **auto-mapping trigger** feature — makes the manual "Auto-map all" button redundant. Built 2026-07-10, plan-driven with subagents. **PR #158 MERGED (squash) to main; migration 20260727 APPLIED to prod.** Plan: `docs/superpowers/plans/2026-07-10-transactions-auto-mapping-trigger.md`.

**What:** auto-map now fires on BOTH triggers for all four sources (application-layer, no DB triggers):
- New shared `lib/finance/autoMap.ts` (pure resolvers + IO wrappers); the 3 auto-map routes are now thin callers.
- Ingest: bank ledger now resolves account from `expense_counterparty_mappings` at ingest (was NEVER mapped before); invoice line items now synced+mapped on the Square invoice webhook + finance-sync cron (webhook previously only reconciled status). POS + expenses already mapped at ingest.
- Rule-edit cascade: catalog-variation edits (`account-mappings` PATCH + bulk) back-fill POS+invoice; counterparty edits (`expense-counterparty-mappings` PATCH) back-fill expenses+bank ledger. GL-rule cascade was pre-existing.
- Webhook uses `syncSquareInvoiceById` (per-invoice), NOT full-year resync (perf fix from review).

**Migration:** `20260727_bank_ledger_counterparty_key.sql` (adds `counterparty_key` to `ramp_bank_ledger`) — APPLIED to prod. It was required before deploy because `syncBankLedger` reads/writes that column and shares `syncAllRamp` with expenses (a missing column would 500 ALL Ramp ingest, not just this feature — same failure mode as [[project_migration_drift_brew_activities]]). See [[feedback_prod_db_migration_authorization]].

**Known behavior:** fill-nulls-only everywhere (rule EDITS don't re-point already-mapped rows — must clear row first); invoice webhook syncs current year only (prior-year self-heals via cron).
