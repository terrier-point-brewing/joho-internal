-- Purge empty shell orders from square_orders.
--
-- Square emits a COMPLETED or CANCELED order with no line items and no money for
-- everyday register events that were never sales: a cash-drawer open (the "No
-- Sale" button), a ticket started on the POS and abandoned, a tab whose items
-- were all removed before it was closed at $0.
--
-- The sync persisted every one of them, so each became a blank $0 row in
-- Transactions → Orders with nothing to show and nothing to map — permanently
-- "unmapped", and inflating the order count. `classifyOrderForSync` now skips
-- them at the source (lib/finance/syncPosTransactions.ts, via
-- lib/square/emptyOrders.ts), so this clears the ones already stored; a re-sync
-- will not bring them back.
--
-- Zero financial impact by construction: the predicate below requires zero
-- total, tax and tip, and zero line items, so nothing here ever reached the
-- P&L, the tax base, or a statement. The two guards on dependent rows are
-- belt-and-braces — a row with line items cannot match the raw_data test, and no
-- refund pointed at one of these when this was written.
--
-- Idempotent: re-running deletes nothing once the set is empty.

begin;

with purged as (
  delete from public.square_orders o
  where coalesce(jsonb_array_length(o.raw_data -> 'line_items'), 0) = 0
    and coalesce(o.total_cents, 0) = 0
    and coalesce(o.tax_cents, 0)   = 0
    and coalesce(o.tip_cents, 0)   = 0
    and not exists (select 1 from public.pos_line_items li where li.order_id = o.id)
    and not exists (select 1 from public.square_refunds r where r.order_id = o.id)
  returning o.id
)
select count(*) as purged_empty_shell_orders from purged;

commit;
