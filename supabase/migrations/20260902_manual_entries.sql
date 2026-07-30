-- supabase/migrations/20260902_manual_entries.sql
--
-- manual_entries — the auditable home for manual financial entries, replacing
-- the ad hoc manual_net_sales_entries rows that used to be edited under
-- Taproom > Targets with no account, no audit trail, and no balance-sheet kind.
--
-- Two kinds share one table:
--   * 'flow'    — a P&L amount over a date RANGE (start_date..end_date).
--   * 'balance' — a balance-sheet amount AS OF a month end (as_of_date).
--
-- amount_cents is SIGNED. Negative is legitimate for both kinds: a negative
-- flow is a correction, and a negative balance is how this codebase stores
-- contra-accounts (e.g. Accumulated Depreciation) and credit-side accounts.
-- There is deliberately no positivity constraint.
--
-- The kind/date rules are mirrored in lib/finance/manualEntries.ts
-- (validateManualEntry / monthEnd) so the API returns a readable 400 instead of
-- surfacing Postgres 23514.

-- ── 1. Table ────────────────────────────────────────────────────────────────
create table if not exists public.manual_entries (
  id                   uuid        primary key default gen_random_uuid(),
  entry_kind           text        not null check (entry_kind in ('flow', 'balance')),
  chart_of_accounts_id uuid        not null references public.chart_of_accounts(id),

  -- 'flow' owns start_date/end_date; 'balance' owns as_of_date. Enforced below.
  start_date           date,
  end_date             date,
  as_of_date           date,

  amount_cents         bigint      not null,
  label                text,
  note                 text,

  mapping_source       text        not null default 'manual',

  -- QuickBooks push state, same shape as expenses / ramp_bank_ledger
  -- (20260805_expenses_qb_sync_status.sql). Null until an export runs.
  qb_remote_id         text,
  qb_sync_status       text,
  qb_synced_at         timestamptz,

  created_at           timestamptz not null default now(),
  created_by           uuid        references auth.users(id),
  updated_at           timestamptz not null default now(),
  updated_by           uuid        references auth.users(id),

  -- ── 2. Kind/date CHECK ────────────────────────────────────────────────────
  -- The month-end clause on 'balance' is load-bearing: the snapshot layer only
  -- ever reads balances keyed to a month end, so a mid-month value would be
  -- silently invisible. Reject it here rather than discover it downstream.
  constraint manual_entries_kind_dates check (
    (entry_kind = 'flow'
       and start_date is not null and end_date is not null
       and as_of_date is null and start_date <= end_date)
    or
    (entry_kind = 'balance'
       and as_of_date is not null
       and start_date is null and end_date is null
       and as_of_date = (date_trunc('month', as_of_date) + interval '1 month - 1 day')::date)
  )
);

comment on table public.manual_entries is
  'Manual financial entries, auditable via audit_log. entry_kind = flow (P&L amount over start_date..end_date) or balance (balance-sheet amount as of a month end). amount_cents is signed; negative is legitimate for contra- and credit-side accounts.';
comment on column public.manual_entries.amount_cents is 'integer cents, signed';
comment on column public.manual_entries.mapping_source is
  'How chart_of_accounts_id was chosen. ''manual'' for operator-entered rows.';

-- ── 3. One balance per account per period ───────────────────────────────────
-- A correction is an UPDATE (history lands in audit_log), never a duplicate row.
create unique index if not exists manual_entries_one_balance_per_period
  on public.manual_entries (chart_of_accounts_id, as_of_date)
  where entry_kind = 'balance';

-- ── 4. Lookup index ─────────────────────────────────────────────────────────
create index if not exists manual_entries_coa_kind
  on public.manual_entries (chart_of_accounts_id, entry_kind);

-- ── 5. Audit trigger ────────────────────────────────────────────────────────
-- Reuses the generic function from 20260609_baseline.sql that already backs 16
-- production tables. Do not write a new one.
drop trigger if exists manual_entries_audit on public.manual_entries;
create trigger manual_entries_audit
  after insert or update or delete on public.manual_entries
  for each row execute function public.audit_trigger_fn();

-- Repo convention (same pair the dropped manual_net_sales_entries carried):
-- keep updated_at honest regardless of what the caller sends.
drop trigger if exists manual_entries_updated_at on public.manual_entries;
create trigger manual_entries_updated_at
  before update on public.manual_entries
  for each row execute function public.update_updated_at();

-- ── 6. RLS ──────────────────────────────────────────────────────────────────
-- The one-line applicator from 20260822_rls_grant_aware_policies.sql.
-- NOTE: it grants write at 'operate' while the app layer gates on 'manage'.
-- The app is deliberately the stricter of the two; do not loosen the app guard.
alter table public.manual_entries enable row level security;
select public.apply_grant_policies('manual_entries', 'finance.transactions');

-- apply_grant_policies ALONE is not sufficient here, and this is the trap:
-- its predicate bottoms out in effective_grant_level(), which is gated on
-- `get_my_role() = 'custom'` (20260822_rls_grant_aware_policies.sql:54). On the
-- payroll tables it was only ever ADDITIVE, layered over an existing role
-- policy. This table has no such sibling, so with the grant pair alone every
-- viewer/brewer/manager/admin matches NO policy -- SELECT returns zero rows
-- with no error, which reads as "no entries" in the UI and silently drops the
-- prorated manual adjustment out of /api/finance/pl and /api/net-sales-summary.
--
-- Flow rows are readable by any authenticated user, restoring exactly the
-- posture their predecessor had: manual_net_sales_entries carried the phase-1
-- catch-all `using (true)` (20260709_enable_rls_phase1.sql) and was
-- deliberately NOT tightened in phase 3. /api/net-sales-summary depends on
-- that -- it is reached from the Taproom Achievement tab under CAP.targetsRead,
-- a TAPROOM capability, so it cannot be moved behind a finance guard or onto
-- the admin client without breaking taproom users who have no finance access.
--
-- Balance rows are deliberately NOT covered: they carry bank and equity
-- balances and stay service-role-only, reached exclusively through
-- /api/finance/manual-entries, which uses the admin client behind
-- CAP.financeTransactions{Read,Manage} -- the same pattern as the
-- chart-of-accounts and expenses routes, and consistent with
-- finance_reader_roles() returning an empty array on purpose
-- (20260709_rls_phase3_tighten_sensitive.sql:31-33).
create policy "manual flow readers" on public.manual_entries
  for select to authenticated
  using ( entry_kind = 'flow' );

-- ── 6b. coa_reference_count: DELIBERATELY NOT EXTENDED HERE ────────────────
-- The final review correctly flagged that coa_reference_count
-- (20260802_coa_reference_count.sql) has no manual_entries arm, so deleting an
-- account referenced only by a manual entry reports zero references and then
-- raises an opaque 23503 instead of the designed 409.
--
-- Extending it means CREATE OR REPLACE with the whole body restated, and that
-- body is ALREADY BROKEN AGAINST PRODUCTION: it references
-- square_catalog_variations.bs_chart_of_accounts_id / pl_chart_of_accounts_id,
-- which do not exist in prod. Verified live -- calling the function today
-- returns 42703 "column bs_chart_of_accounts_id does not exist", so the per-row
-- CoA delete in Settings is already failing, independently of this feature.
--
-- Those two columns are added by 20260615_deposit_recognition.sql and dropped by
-- 20260802_retire_deposit_recognition_columns.sql -- which shares the 20260802
-- prefix with coa_reference_count itself (grandfathered in
-- scripts/check-migrations.mjs), so the CLI treats applying either as applying
-- both. Restating the body here would make THIS migration abort on prod at
-- CREATE time, turning a clean apply into a partial one.
--
-- Fixing that drift is its own change and needs a decision about which columns
-- are real. It does not belong inside a feature migration. Tracked as follow-up.

-- ── 7. Data migration from manual_net_sales_entries ─────────────────────────
-- Every legacy row becomes a 'flow' against 4100 BREWERY REVENUE:Taproom
-- Revenue. created_by stays null: the source table never recorded it, and an
-- honest null beats a backfilled guess.
do $$
declare
  v_coa_id uuid;
  v_moved  bigint;
begin
  if to_regclass('public.manual_net_sales_entries') is null then
    raise notice 'manual_net_sales_entries absent; nothing to migrate';
    return;
  end if;

  select id into v_coa_id
    from public.chart_of_accounts
   where account_number = '4100'
   order by is_active desc, uploaded_at desc
   limit 1;

  if v_coa_id is null then
    raise exception
      'manual_entries migration: no chart_of_accounts row with account_number = ''4100'' (BREWERY REVENUE:Taproom Revenue); cannot resolve chart_of_accounts_id for the manual_net_sales_entries backfill';
  end if;

  insert into public.manual_entries (
    id, entry_kind, chart_of_accounts_id,
    start_date, end_date, amount_cents, label,
    created_at, updated_at
  )
  select m.id, 'flow', v_coa_id,
         m.start_date, m.end_date, m.amount_cents, m.label,
         m.created_at, m.updated_at
    from public.manual_net_sales_entries m
  on conflict (id) do nothing;

  get diagnostics v_moved = row_count;
  raise notice 'manual_entries migration: moved % manual_net_sales_entries row(s) to chart_of_accounts %', v_moved, v_coa_id;
end $$;

-- ── 8. Retire the source table ──────────────────────────────────────────────
drop table if exists public.manual_net_sales_entries;
