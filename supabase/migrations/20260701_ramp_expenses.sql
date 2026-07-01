-- supabase/migrations/20260701_ramp_expenses.sql
-- Ramp expense import + chart-of-accounts mapping infrastructure.
--
-- Two tables:
--   1. ramp_gl_account_mappings — reusable rule that maps a Ramp GL account
--      (the QuickBooks account each expense is coded against, surfaced via the
--      transaction's accounting_field_selections) to a chart_of_accounts row.
--      Because Ramp mirrors the same chart of accounts, most rules are created
--      automatically by direct name/number match on first import — the user
--      only touches the ones that don't match.
--   2. ramp_expenses — one clean record per Ramp transaction. chart_of_accounts_id
--      is resolved from the rule table on sync, unless the user has pinned a
--      per-expense override (mapping_source = 'manual'), which is never
--      overwritten by a re-sync.

-- ── ramp_gl_account_mappings ─────────────────────────────────────────────────
create table if not exists public.ramp_gl_account_mappings (
  id                   uuid        primary key default gen_random_uuid(),
  -- Stable key for the Ramp GL account. Prefer the accounting field option id;
  -- falls back to the external (ERP/QuickBooks) id or the raw name upstream.
  ramp_gl_id           text        not null unique,
  ramp_gl_name         text        not null,
  -- External/QuickBooks account id or number, when Ramp exposes it.
  ramp_gl_code         text,
  chart_of_accounts_id uuid        references public.chart_of_accounts(id) on delete set null,
  -- true when the system created/resolved the rule by direct match; false once
  -- a user has confirmed or changed it. Lets the UI flag "auto" vs "reviewed".
  auto_matched         boolean     not null default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists idx_ramp_gl_account_mappings_coa
  on public.ramp_gl_account_mappings (chart_of_accounts_id);

-- ── ramp_expenses ─────────────────────────────────────────────────────────────
create table if not exists public.ramp_expenses (
  id                   uuid        primary key default gen_random_uuid(),
  ramp_transaction_id  text        not null unique,
  -- Positive = spend, negative = refund/credit. Stored in cents.
  amount_cents         integer     not null,
  currency_code        text        not null default 'USD',
  memo                 text,
  merchant_name        text,
  merchant_category    text,
  sk_category_name     text,
  state                text,
  card_holder_name     text,
  department_name      text,
  transaction_time     timestamptz,
  accounting_date      date,
  -- Ramp GL account this expense is coded against (join key to the rule table).
  ramp_gl_id           text,
  ramp_gl_name         text,
  ramp_gl_code         text,
  chart_of_accounts_id uuid        references public.chart_of_accounts(id) on delete set null,
  -- How chart_of_accounts_id was resolved:
  --   unmapped — no GL tag, or GL tag has no mapped account yet
  --   rule     — resolved from ramp_gl_account_mappings on sync
  --   manual   — pinned on this expense by a user; sync leaves it alone
  mapping_source       text        not null default 'unmapped'
                         check (mapping_source in ('unmapped', 'rule', 'manual')),
  synced_at            timestamptz not null default now(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists idx_ramp_expenses_gl_id           on public.ramp_expenses (ramp_gl_id);
create index if not exists idx_ramp_expenses_coa             on public.ramp_expenses (chart_of_accounts_id);
create index if not exists idx_ramp_expenses_accounting_date on public.ramp_expenses (accounting_date);

-- ── updated_at triggers ───────────────────────────────────────────────────────
create or replace function set_ramp_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger ramp_gl_account_mappings_updated_at
  before update on public.ramp_gl_account_mappings
  for each row execute procedure set_ramp_updated_at();

create trigger ramp_expenses_updated_at
  before update on public.ramp_expenses
  for each row execute procedure set_ramp_updated_at();

-- ── RLS (mirrors chart_of_accounts: authenticated read, admin/manager manage) ──
alter table public.ramp_gl_account_mappings enable row level security;
alter table public.ramp_expenses            enable row level security;

create policy "Authenticated users can read ramp gl mappings"
  on public.ramp_gl_account_mappings for select
  using (auth.role() = 'authenticated');

create policy "Admins can manage ramp gl mappings"
  on public.ramp_gl_account_mappings for all
  using (
    exists (
      select 1 from profiles p
      where p.id = auth.uid() and p.role in ('admin', 'manager')
    )
  );

create policy "Authenticated users can read ramp expenses"
  on public.ramp_expenses for select
  using (auth.role() = 'authenticated');

create policy "Admins can manage ramp expenses"
  on public.ramp_expenses for all
  using (
    exists (
      select 1 from profiles p
      where p.id = auth.uid() and p.role in ('admin', 'manager')
    )
  );
