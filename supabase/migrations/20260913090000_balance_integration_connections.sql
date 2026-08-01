-- supabase/migrations/20260913090000_balance_integration_connections.sql
--
-- Shared plumbing for integration-backed balance methods (Ramp, Plaid,
-- Square). Built once here so the three integrations do not each invent their
-- own credential storage and their own history table.
--
-- Two tables:
--   integration_connections   -- what we are connected TO, and the secret that
--                                lets us read it.
--   gl_account_daily_balances -- a daily balance capture, for sources that
--                                cannot be asked about the past.
--
-- ── Why a daily capture table is not optional ────────────────────────────────
-- Ramp can return a date range of historical balances. Plaid CANNOT: its
-- balance endpoint answers "what is it right now" and takes no as-of date, so a
-- month-end figure exists only if something recorded it at the time. Square is
-- the same by construction, since its balance is derived from an anchor plus
-- movement. Without a capture table, connecting Plaid in September would mean
-- July's bank balance is unrecoverable at any price.
--
-- The monthly snapshot (gl_account_balances) stays the source of truth for the
-- statement. This table is the raw daily feed those month-end figures are drawn
-- from -- one row per account per day, not per month.

-- ── 1. integration_connections ───────────────────────────────────────────────
create table if not exists public.integration_connections (
  id            uuid        primary key default gen_random_uuid(),

  -- 'ramp' | 'plaid' | 'square'. Deliberately not an enum: a new integration
  -- should be a code change plus a row, never a type migration.
  provider      text        not null,

  -- Human label for the Settings row, e.g. "Ramp · Operating".
  label         text        not null,

  -- The account's identifier AT the provider (Ramp treasury account uuid,
  -- Plaid account_id, Square location id). Null while a connection is being
  -- set up and no account has been chosen yet.
  external_id   text,

  -- Secrets. Plaid's access_token is minted per bank connection at link time,
  -- so unlike Ramp's client credentials it cannot live in an env var and has
  -- to be stored. Service-role only -- see the RLS note below. Never select
  -- this column into an API response.
  credentials   jsonb       not null default '{}',

  -- Non-secret provider settings (which sub-account, an anchor date, etc).
  config        jsonb       not null default '{}',

  status        text        not null default 'active'
                  check (status in ('active', 'needs_reauth', 'disabled', 'error')),
  last_synced_at timestamptz,
  last_error     text,

  created_at    timestamptz not null default now(),
  created_by    uuid        references auth.users(id),
  updated_at    timestamptz not null default now(),
  updated_by    uuid        references auth.users(id)
);

comment on table public.integration_connections is
  'One row per external account a balance method reads from. Holds the credential where the provider issues a per-connection secret (Plaid), and connection health for the Settings > Balance Sheet Accounts status line.';
comment on column public.integration_connections.credentials is
  'SECRET. Service-role only; never expose through an API response. Plaid access_token lives here because it is minted per connection at link time and cannot be an env var.';
comment on column public.integration_connections.status is
  'active | needs_reauth (credential expired, user must relink) | disabled | error (last read failed, see last_error).';

-- One connection per external account per provider. Partial, because
-- external_id is null until setup completes and several half-configured rows
-- must not collide.
create unique index if not exists integration_connections_provider_external
  on public.integration_connections (provider, external_id)
  where external_id is not null;

-- ── 2. gl_account_daily_balances ─────────────────────────────────────────────
create table if not exists public.gl_account_daily_balances (
  id                   uuid        primary key default gen_random_uuid(),
  chart_of_accounts_id uuid        not null references public.chart_of_accounts(id),
  as_of_date           date        not null,
  balance_cents        bigint      not null,

  -- Which connection produced it. Nullable so a manually seeded historical
  -- balance -- the only way to get history for an account connected late --
  -- can be recorded honestly rather than attributed to a feed that did not
  -- produce it.
  connection_id        uuid        references public.integration_connections(id) on delete set null,

  captured_at          timestamptz not null default now(),

  unique (chart_of_accounts_id, as_of_date)
);

comment on table public.gl_account_daily_balances is
  'Daily balance capture for sources that cannot be queried retroactively (Plaid especially). The monthly snapshot in gl_account_balances reads its month-end row from here. Internal sign convention: assets positive, liabilities and equity negative.';
comment on column public.gl_account_daily_balances.connection_id is
  'Null for a hand-seeded historical balance, which is the only way to backfill an account connected after the fact.';

create index if not exists gl_account_daily_balances_account_date
  on public.gl_account_daily_balances (chart_of_accounts_id, as_of_date desc);

-- ── 3. RLS ───────────────────────────────────────────────────────────────────
-- Lock-down route, matching gl_account_balances and manual_entries' balance
-- rows (20260905100000, 20260904120000).
--
-- apply_grant_policies is ADDITIVE-ONLY: its predicate bottoms out in
-- effective_grant_level(), gated on `get_my_role() = 'custom'`, so on its own
-- it denies every real viewer/brewer/manager/admin. A SELECT matching no policy
-- returns ZERO ROWS WITH NO ERROR, which renders as a plausible empty state.
-- That is exactly why no broad read policy is added here and every read goes
-- through a route using createSupabaseAdminClient() behind requirePermission.
--
-- For integration_connections that posture is not merely conventional: the
-- table holds live bank credentials. Do not add a read policy to it under any
-- circumstances.
alter table public.integration_connections   enable row level security;
alter table public.gl_account_daily_balances enable row level security;

select public.apply_grant_policies('integration_connections',   'finance.transactions');
select public.apply_grant_policies('gl_account_daily_balances', 'finance.statements');

-- ── 4. Audit + updated_at ────────────────────────────────────────────────────
-- Reuses the generic function from 20260609_baseline.sql.
--
-- NOTE: audit_trigger_fn() writes the changed row into audit_log. On
-- integration_connections that would copy `credentials` into an audit table
-- with a different access posture, so connections are deliberately NOT audited
-- at row level here. Connection changes are low-volume and operator-initiated;
-- leaking a bank token into audit_log to record them is a bad trade.
drop trigger if exists integration_connections_updated_at on public.integration_connections;
create trigger integration_connections_updated_at
  before update on public.integration_connections
  for each row execute function public.update_updated_at();

drop trigger if exists gl_account_daily_balances_audit on public.gl_account_daily_balances;
create trigger gl_account_daily_balances_audit
  after insert or update or delete on public.gl_account_daily_balances
  for each row execute function public.audit_trigger_fn();

-- ── 5. coa_reference_count arm ───────────────────────────────────────────────
-- gl_account_daily_balances carries a chart_of_accounts_id FK with no ON DELETE
-- clause, so without an arm here deleting a referenced account reports zero
-- references and Postgres then raises a raw 23503 instead of the designed 409
-- from app/api/finance/chart-of-accounts/route.ts.
--
-- Body restated from 20260905100000_balance_sheet_snapshots.sql -- the current
-- correct version -- with one arm appended. Do NOT copy from
-- 20260802_coa_reference_count.sql, which references dropped columns.
create or replace function public.coa_reference_count(p_account_id uuid)
returns table(source text, n bigint)
language sql
stable
security definer
set search_path = public
as $$
  select 'account mappings'::text, count(*)::bigint from square_catalog_variations
    where chart_of_accounts_id = p_account_id
       or chart_of_accounts_id_pos = p_account_id
       or chart_of_accounts_id_invoice = p_account_id
  union all
  select 'invoice line items', count(*) from invoice_line_items
    where chart_of_accounts_id = p_account_id
  union all
  select 'POS order line items', count(*) from pos_line_items
    where chart_of_accounts_id = p_account_id
  union all
  select 'expenses', count(*) from expenses
    where chart_of_accounts_id = p_account_id
  union all
  select 'expense account rules', count(*) from expense_account_mappings
    where chart_of_accounts_id = p_account_id
  union all
  select 'expense GL splits', count(*) from expense_gl_splits
    where chart_of_accounts_id = p_account_id
  union all
  select 'counterparty rules', count(*) from expense_counterparty_mappings
    where chart_of_accounts_id = p_account_id
  union all
  select 'bank ledger lines', count(*) from ramp_bank_ledger
    where chart_of_accounts_id = p_account_id
  union all
  select 'refunds', count(*) from square_refunds
    where chart_of_accounts_id = p_account_id
  union all
  select 'payroll department mappings', count(*) from payroll_department_gl_mappings
    where chart_of_accounts_id = p_account_id
  union all
  select 'payroll tax account', count(*) from payroll_gl_settings
    where payroll_taxes_chart_of_accounts_id = p_account_id
  union all
  select 'manual entries', count(*) from manual_entries
    where chart_of_accounts_id = p_account_id
  union all
  select 'balance sheet account sources', count(*) from balance_sheet_account_sources
    where chart_of_accounts_id = p_account_id
  union all
  select 'GL account balances', count(*) from gl_account_balances
    where chart_of_accounts_id = p_account_id
  union all
  select 'balance close tasks', count(*) from balance_close_tasks
    where chart_of_accounts_id = p_account_id
  union all
  -- new: 20260913090000_balance_integration_connections.sql
  select 'daily balance captures', count(*) from gl_account_daily_balances
    where chart_of_accounts_id = p_account_id
  union all
  select 'child accounts', count(*) from chart_of_accounts
    where parent_id = p_account_id;
$$;
