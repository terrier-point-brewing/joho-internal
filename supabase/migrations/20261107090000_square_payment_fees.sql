-- ============================================================================
-- Square processing fees — the cost the P&L never saw.
--
-- Square deducts its processing fee before anything reaches the stored
-- balance, so the sweeps arrive net while the P&L counts sales at full net-
-- sales value: roughly $700–900 a month of real cost vanishing between the two
-- (measured against July 2026's payout entries: gross 4,332,371¢ − fees
-- 64,092¢ = payouts to the cent, see lib/square/payouts.ts). Neither the
-- orders feed nor the payouts feed carries the fee per transaction — only the
-- Payments API does — so the fee needs its own synced record before any
-- statement can read it. This is that record, at per-payment grain.
--
-- The statements DERIVE from it (lib/finance/squareFees.ts): a monthly
-- "(Card processing fees)" row on the expense account named in GL 1040's
-- method setup, on the P&L AND the cash-flow statement — unlike depreciation
-- and inventory relief this is a real cash cost, withheld at source — with
-- retained earnings absorbing the same figure. Computed, never posted.
--
-- The finance sync (lib/cron/jobs/financeSync.ts) upserts the trailing window
-- each run, and walks back to the first Square activity when the table is
-- empty — the same first-run-walks-history arrangement the Plaid transaction
-- feed uses.
--
-- Re-runnable end to end.
-- ============================================================================

create table if not exists public.square_payment_fees (
  -- Square's payment id. One row per payment, upserted on every re-sync.
  payment_id text primary key,
  -- The payment's EASTERN local date — fees belong to the sale's business day,
  -- same convention as the rest of the Square data.
  payment_date date not null,
  -- Cents Square kept, stored positive; the statement row negates it.
  fee_cents bigint not null,
  -- The payment's total, kept so a fee can be sanity-checked against what it
  -- was charged on without a second API call.
  total_cents bigint not null,
  synced_at timestamptz not null default now()
);

create index if not exists square_payment_fees_date_idx
  on public.square_payment_fees (payment_date);

alter table public.square_payment_fees enable row level security;
select public.apply_grant_policies('square_payment_fees', 'finance.transactions');
