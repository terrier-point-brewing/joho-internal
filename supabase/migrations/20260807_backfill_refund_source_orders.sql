-- Backfill: repoint square_refunds at the sale each refund reverses.
--
-- A Square refund's order_id is the *return order* Square creates for the
-- refund — an order with no line items, whose returns[].source_order_id names
-- the original sale. syncRefunds historically stored that return order in
-- square_order_id / order_id, so a refund → order drill-through landed on an
-- empty return order instead of what was sold. The sync now resolves the sale
-- at write time (lib/finance/syncRefunds.ts); this fixes rows written before.
--
-- Resolution walks: square_refunds.square_order_id (return order id)
--   → square_orders (the return order, raw_data.returns[0].source_order_id)
--   → the sale order (matched by square_order_id).
--
-- Idempotent: after the update square_order_id names the sale, which carries no
-- returns[] source, so a re-run's join finds nothing. Rows whose square_order_id
-- is already a sale (a refund that pointed straight at its sale, no return
-- order) never match the source_order_id filter and are left untouched.
-- The return-order id remains available in square_refunds.raw_data.order_id.

with resolved as (
  select
    r.id                                                    as refund_id,
    ret.raw_data -> 'returns' -> 0 ->> 'source_order_id'    as source_order_id
  from public.square_refunds r
  join public.square_orders ret
    on ret.square_order_id = r.square_order_id
  where ret.raw_data -> 'returns' -> 0 ->> 'source_order_id' is not null
)
update public.square_refunds r
set
  square_order_id = resolved.source_order_id,
  order_id        = sale.id,          -- null if the sale isn't in square_orders yet; the next sync fills it
  updated_at      = now()
from resolved
left join public.square_orders sale
  on sale.square_order_id = resolved.source_order_id
where r.id = resolved.refund_id;
