-- supabase/migrations/20260805_expenses_qb_sync_status.sql
-- Record Ramp's QuickBooks sync state per object, so the Transactions tabs can
-- show "is this already in QuickBooks?" and a future export route can EXCLUDE
-- objects Ramp already pushed (Ramp's native QuickBooks integration is DIRECT,
-- and it surfaces this state over the developer API).
--
-- Three nullable columns on both source-agnostic ledger tables. The raw Ramp
-- sync_status enum differs per ramp_object (card: NOT_SYNC_READY|SYNC_READY|
-- SYNCED; bill: NOT_SYNCED|BILL_SYNCED|BILL_AND_PAYMENT_SYNCED; bank: same-as-
-- card per docs), so we store the RAW value and normalize in code
-- (lib/finance/qbSyncStatus.ts) — this preserves the bill-vs-payment nuance.
--
-- NOTE the distinct name: expenses.synced_at ALREADY EXISTS and means "when our
-- app last upserted this row from Ramp". These qb_* columns are a different
-- concept (Ramp → QuickBooks), hence the qb_ prefix.
--
-- No backfill: existing rows stay NULL until the next Ramp sync re-upserts them
-- in place (upsert key (source, source_transaction_id)). No destructive ops.

-- ── expenses ─────────────────────────────────────────────────────────────────
alter table public.expenses add column if not exists qb_sync_status text;
alter table public.expenses add column if not exists qb_synced_at   timestamptz;
alter table public.expenses add column if not exists qb_remote_id   text;

comment on column public.expenses.qb_sync_status is
  'Raw Ramp sync_status (enum varies by ramp_object). Whether Ramp has synced this object to the connected ERP (QuickBooks). Normalized for display in lib/finance/qbSyncStatus.ts.';
comment on column public.expenses.qb_synced_at is
  'When Ramp pushed this object to QuickBooks (from the transaction synced_at). Null for bills/bank lines.';
comment on column public.expenses.qb_remote_id is
  'The QuickBooks object id Ramp created (bill remote_id). Null for card/bank rows. Dedup key for the future QB export route.';

create index if not exists idx_expenses_qb_sync_status on public.expenses (qb_sync_status);

-- ── ramp_bank_ledger ─────────────────────────────────────────────────────────
alter table public.ramp_bank_ledger add column if not exists qb_sync_status text;
alter table public.ramp_bank_ledger add column if not exists qb_synced_at   timestamptz;
alter table public.ramp_bank_ledger add column if not exists qb_remote_id   text;

comment on column public.ramp_bank_ledger.qb_sync_status is
  'Raw Ramp bank-line sync_status. Whether Ramp has synced this line to QuickBooks. Normalized in lib/finance/qbSyncStatus.ts.';
