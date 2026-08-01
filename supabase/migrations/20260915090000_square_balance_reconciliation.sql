-- supabase/migrations/20260915090000_square_balance_reconciliation.sql
--
-- The drift log behind GL 1040 Square Deposit Account.
--
-- ── Why this table has to exist ──────────────────────────────────────────────
-- Square publishes no balance endpoint, so 1040 is derived: a verified balance
-- an operator entered, plus everything Square has settled in since. The inflow
-- half is exact -- Square's payout totals are already net of processing fees
-- and refunds and reconcile to the cent.
--
-- The OUTFLOW half is invisible. Withdrawals from the Square balance to a bank
-- appear in no payout (this merchant has never had a BANK_ACCOUNT payout, only
-- stored-balance settlements), in no posting to 1040 (the account carries none
-- at all), and cannot be recovered from the bank side (the Ramp ledger's
-- uncoded "Deposit" rows are the right order of magnitude but match no
-- accumulation window).
--
-- So each month end the operator re-anchors: they check Square, enter the real
-- figure, and that becomes the new starting point. Re-anchoring is self-
-- healing, which is its virtue and its danger -- it silently absorbs whatever
-- the derivation missed, including a genuine bug in the derivation. This table
-- is the record of what got absorbed, so "the balance is always right by
-- construction" cannot hide "the calculation has been wrong for four months".
--
-- Expect a modest negative drift each month: that is ordinary sweeping to the
-- bank. Positive or erratic drift means the derivation is missing something.

create table if not exists public.square_balance_reconciliations (
  id                   uuid        primary key default gen_random_uuid(),

  chart_of_accounts_id uuid        not null references public.chart_of_accounts(id) on delete cascade,

  -- The month end being closed. One row per account per period.
  period_end           date        not null,

  -- The PRIOR verified balance this month's derivation started from, and its
  -- date. Stored rather than re-derived: the anchor is an operator entry that
  -- can later be edited, and a drift figure whose inputs can change underneath
  -- it is not evidence of anything.
  anchor_date          date        not null,
  anchor_cents         bigint      not null,

  -- Net settlements from Square across (anchor_date, period_end].
  payouts_cents        bigint      not null,

  -- anchor_cents + payouts_cents, i.e. what the balance sheet reported.
  derived_cents        bigint      not null,

  -- What the operator found in Square. This becomes the next month's anchor.
  actual_cents         bigint      not null,

  -- actual - derived. NEGATIVE is the expected direction: the real balance came
  -- in below the derived one because money left without leaving a trace.
  drift_cents          bigint      not null,

  computed_at          timestamptz not null default now(),

  constraint square_balance_reconciliations_one_per_period
    unique (chart_of_accounts_id, period_end)
);

comment on table public.square_balance_reconciliations is
  'Month-end re-anchoring log for Square-derived balances: what the derivation predicted, what the operator found, and the difference. The only visibility into withdrawals from the Square balance, which appear in no other source.';

create index if not exists square_balance_reconciliations_period_idx
  on public.square_balance_reconciliations (period_end desc);

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- Same posture as the rest of the balance-sheet tables: apply_grant_policies is
-- additive-only and bottoms out in effective_grant_level(), so this grants the
-- custom-role path and nothing else. Every application read goes through the
-- service-role admin client behind requirePermission. A SELECT matching no
-- policy returns zero rows rather than an error, which is the intended
-- lock-down default -- do not add a broad read policy to make something work.
alter table public.square_balance_reconciliations enable row level security;

select public.apply_grant_policies('square_balance_reconciliations', 'finance.statements');
