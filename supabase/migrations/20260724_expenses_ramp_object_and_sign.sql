-- supabase/migrations/20260724_expenses_ramp_object_and_sign.sql
-- Two coupled changes to the source-agnostic expenses ledger:
--
-- 1. ramp_object — which Ramp resource a row came from. Existing rows are all
--    card transactions; bills (this plan) and bank lines (Plan B) reuse the same
--    table with source='ramp' and are told apart by this column.
-- 2. Sign convention flip — move to accounting style: amount_cents is now signed
--    by CASH DIRECTION (outflow negative, inflow positive). Existing rows stored
--    spend as POSITIVE; negate them once so the whole ledger is consistent.
--
-- WARNING: the UPDATE is a one-time, NON-idempotent negation. Migrations run
-- exactly once (tracked), so this is safe as a forward migration — do NOT re-run
-- it by hand against a DB that already has it applied.

alter table public.expenses
  add column ramp_object text not null default 'card'
    check (ramp_object in ('card', 'bill', 'bank'));
-- Existing rows are correctly defaulted to 'card'; drop the default so new
-- inserts must state their object explicitly.
alter table public.expenses alter column ramp_object drop default;

create index if not exists idx_expenses_ramp_object on public.expenses (ramp_object);

-- Flip existing spend (positive) to outflow-negative; existing credits/refunds
-- (negative) become positive inflows. One-time.
update public.expenses set amount_cents = -amount_cents;

comment on column public.expenses.amount_cents is
  'Signed by cash direction: outflow (spend) negative, inflow (refund/credit) positive. Integer cents.';
comment on column public.expenses.ramp_object is
  'Which Ramp resource this row came from: card | bill | bank.';
