-- Allocation adjustment + refund flow (Spec 2c-2): capture the Square
-- payment ID at the moment a deposit invoice is detected as paid (the only
-- point Square makes it available), and add a refund audit trail so a paid
-- allocation's percentage can be reduced with a real Square refund instead
-- of a hard block.

alter table public.batch_allocations
  add column square_payment_id text,
  add column deposit_amount_paid_cents integer,
  add column square_refund_id text,
  add column refund_amount_cents integer,
  add column refunded_at timestamptz;
