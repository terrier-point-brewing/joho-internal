-- supabase/migrations/20260715_taproom_export_status_paid.sql
-- Taproom consumption is internal — payment is collected at the point of sale,
-- so those export rows should never enter the invoicing workflow. New rows are
-- written as 'paid' by lib/production/exportTransactionWriter (initialExportStatus).
-- Backfill existing taproom rows that were stuck at the table default.
update public.export_transactions
   set status = 'paid'
 where channel = 'taproom'
   and status = 'invoice_required';
