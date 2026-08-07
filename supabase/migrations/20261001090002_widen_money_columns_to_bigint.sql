-- Make the money columns agree on their width.
--
-- Five integer *_cents columns are summed, compared, or rolled up against
-- bigint *_cents columns. The arithmetic already happens in bigint — Postgres
-- promotes the narrower side — so nothing is wrong with the numbers today. What
-- is wrong is that the two sides of the same quantity disagree about their
-- range, and the narrow side is the one that receives writes:
--
--   expenses.amount_cents (int)             vs expense_gl_splits.amount_cents (bigint)
--   ramp_bank_ledger.amount_cents (int)     rolls into gl_account_balances.balance_cents (bigint)
--   pos_line_item_taxes.amount_cents (int)  vs pos_line_items.tax_cents (bigint)
--   invoice_line_item_taxes.amount_cents (int) vs invoice_line_items.tax_cents (bigint)
--   square_refunds.amount_cents (int)       vs square_orders.total_cents (bigint)
--
-- int4 tops out at $21,474,836.47. No single row here will reach that, and the
-- point is not that one might. The point is that a split can be widened and its
-- parent cannot hold the result, and that every reader has to know which of two
-- identically-named columns is the narrow one. Types are how that is said once
-- instead of remembered everywhere. Verified against production 2026-08-07:
-- these five are integer, and each column named opposite them is bigint.
--
-- Trivial to rewrite: 271 / 58 / 9,961 / 5 / 12 rows. ALTER TYPE takes an ACCESS
-- EXCLUSIVE lock and rewrites the table, which at these sizes is milliseconds.
-- No view or generated column reads any of them, so nothing has to be dropped
-- and recreated around the change.

alter table public.expenses
  alter column amount_cents type bigint;

alter table public.ramp_bank_ledger
  alter column amount_cents type bigint;

alter table public.pos_line_item_taxes
  alter column amount_cents type bigint;

alter table public.invoice_line_item_taxes
  alter column amount_cents type bigint;

alter table public.square_refunds
  alter column amount_cents type bigint;
