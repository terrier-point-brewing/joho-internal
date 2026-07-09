-- supabase/migrations/20260725_ramp_bank_ledger.sql
-- Operating bank-account money movement from Ramp.
--
--   1. ramp_bank_ledger — non-expense bank lines (interest income, internal
--      transfers, bill/card settlements, deposits, unclassified). Operating-
--      expense bank debits do NOT live here — they go to `expenses`
--      (ramp_object='bank'), coded via the counterparty rule table below.
--   2. expense_counterparty_mappings — reusable rule mapping a bank counterparty
--      (e.g. GUSTO, ERIE INSURANCE) to a chart_of_accounts row. Bank lines carry
--      no GL coding, so this is how their expenses get an account. Unlike GL
--      rules these don't auto-match by name (GUSTO ≠ "Payroll"); the user assigns.
--   3. expenses.counterparty_key/label — so bank-sourced expense rows re-resolve
--      their account from the counterparty rule on every sync.

-- ── ramp_bank_ledger ─────────────────────────────────────────────────────────
create table if not exists public.ramp_bank_ledger (
  id                    uuid        primary key default gen_random_uuid(),
  source                text        not null default 'ramp' check (source in ('ramp')),
  source_transaction_id text        not null,
  -- Signed by cash direction: outflow negative, inflow positive. Integer cents.
  amount_cents          integer     not null,
  currency_code         text        not null default 'USD',
  description           text,            -- Ramp's raw description (Withdrawal/Deposit/Interest/Vendor Payment)
  counterparty_name     text,            -- external party or own-account name
  source_account_name   text,
  destination_account_name text,
  flow_type             text        not null
                          check (flow_type in ('interest_income','internal_transfer','bill_settlement','card_settlement','deposit','unclassified')),
  affects_pl            boolean     not null,
  transaction_date      date,
  chart_of_accounts_id  uuid        references public.chart_of_accounts(id) on delete set null,
  mapping_source        text        not null default 'unmapped'
                          check (mapping_source in ('unmapped','rule','manual')),
  synced_at             timestamptz not null default now(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint ramp_bank_ledger_source_txn_unique unique (source, source_transaction_id)
);

create index if not exists idx_ramp_bank_ledger_flow_type on public.ramp_bank_ledger (flow_type);
create index if not exists idx_ramp_bank_ledger_txn_date  on public.ramp_bank_ledger (transaction_date);

-- ── expense_counterparty_mappings ────────────────────────────────────────────
create table if not exists public.expense_counterparty_mappings (
  id                   uuid        primary key default gen_random_uuid(),
  source               text        not null default 'ramp' check (source in ('ramp')),
  -- Normalized counterparty key (lowercased/trimmed) — the join key.
  counterparty_key     text        not null,
  counterparty_label   text        not null,
  chart_of_accounts_id uuid        references public.chart_of_accounts(id) on delete set null,
  auto_matched         boolean     not null default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint expense_counterparty_mappings_source_key_unique unique (source, counterparty_key)
);

create index if not exists idx_expense_counterparty_mappings_coa
  on public.expense_counterparty_mappings (chart_of_accounts_id);

-- ── expenses: counterparty columns (for bank-sourced expense rows) ───────────
alter table public.expenses add column if not exists counterparty_key   text;
alter table public.expenses add column if not exists counterparty_label text;

-- ── triggers (reuse the shared updated_at fn from earlier migrations) ─────────
create trigger ramp_bank_ledger_updated_at
  before update on public.ramp_bank_ledger
  for each row execute procedure set_expense_updated_at();

create trigger expense_counterparty_mappings_updated_at
  before update on public.expense_counterparty_mappings
  for each row execute procedure set_expense_updated_at();

-- ── RLS (mirror expenses: authenticated read, admin/manager manage) ──────────
alter table public.ramp_bank_ledger              enable row level security;
alter table public.expense_counterparty_mappings enable row level security;

create policy "Authenticated users can read bank ledger"
  on public.ramp_bank_ledger for select using (auth.role() = 'authenticated');
create policy "Admins can manage bank ledger"
  on public.ramp_bank_ledger for all using (
    exists (select 1 from profiles p where p.id = auth.uid() and p.role in ('admin','manager')));

create policy "Authenticated users can read counterparty mappings"
  on public.expense_counterparty_mappings for select using (auth.role() = 'authenticated');
create policy "Admins can manage counterparty mappings"
  on public.expense_counterparty_mappings for all using (
    exists (select 1 from profiles p where p.id = auth.uid() and p.role in ('admin','manager')));
