-- When a bill this business owes was actually paid.
--
-- `expenses.state` already says whether a Ramp bill is OPEN or PAID, but it says
-- so as of the last sync -- it is overwritten in place, so it can only ever
-- answer "is this owed TODAY". Accounts payable needs the other question: was it
-- owed on the 30th of June. Ramp's bill object carries `paid_at`, an immutable
-- timestamp, so that question IS answerable -- but only if the answer is kept.
--
-- Nullable, and null means two different things depending on `state`: an OPEN
-- bill has not been paid, a PAID bill was paid before this column existed and
-- has not been re-synced since. lib/finance/rampSync.ts refreshes every bill on
-- every sync (bill volume is ~20 records in total) rather than only those in the
-- caller's window, precisely so the second case empties out and stays empty.
--
-- Only Ramp bills populate it. A card swipe has no gap between being incurred
-- and being paid, and a bank line IS the payment, so for those it stays null.
alter table public.expenses
  add column if not exists settled_at timestamptz;

comment on column public.expenses.settled_at is
  'When a bill was paid (Ramp bills only; null for card and bank rows). Unlike `state`, this is not overwritten as status moves on, so it is what lets accounts payable be reconstructed for a past month end.';

-- The accounts-payable provider asks for bill rows issued on or before a month
-- end, then splits them on settled_at. `ramp_object` is the selective half (107
-- bill rows against tens of thousands of card rows), so lead with it.
create index if not exists expenses_bill_settlement_idx
  on public.expenses (ramp_object, accounting_date)
  where ramp_object = 'bill';
