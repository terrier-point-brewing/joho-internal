-- Shipment editing (phase 1): audit trail + operator edit reason.
--
-- 1. edit_reason — the operator's stated reason for the most recent edit to a
--    shipment. Required by PATCH /api/production/shipments/[id] whenever the
--    channel changes. The column only holds the LATEST reason; the full
--    reasoned history falls out of audit_log.new_data (see below), so no
--    separate edit-history table is needed.
--
-- 2. The missing audit trigger. export_transactions has never had one. The
--    batch_exports table it replaced in 20260622_export_transactions.sql DID
--    have one (audit_batch_exports); it was not carried over when that table
--    was dropped. This is a pre-existing gap, not one introduced by shipment
--    editing: the unguarded PATCH/DELETE on /api/production/exports/[id]
--    currently mutates and hard-deletes ledger rows with no trail at all.
--
--    audit_trigger_fn already records table_name, record_id, operation,
--    user_id (auth.uid()), changed_at, and full old_data/new_data jsonb into
--    public.audit_log — a complete channel-change history for free.
--
-- Idempotent. No backfill. Touches no other table.

alter table public.export_transactions
  add column if not exists edit_reason text;

comment on column public.export_transactions.edit_reason is
  'Operator''s reason for the most recent edit. Latest value only — full history lives in audit_log.';

drop trigger if exists audit_export_transactions on public.export_transactions;
create trigger audit_export_transactions
  after insert or update or delete on public.export_transactions
  for each row execute function public.audit_trigger_fn();
