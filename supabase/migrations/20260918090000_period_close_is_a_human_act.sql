-- supabase/migrations/20260918090000_period_close_is_a_human_act.sql
--
-- Closing a month becomes something a person does, with their name on it.
--
-- ── What was wrong ───────────────────────────────────────────────────────────
-- The nightly cron froze a period when every close task was done OR the due
-- date had passed. The second condition turns "the deadline went by" into
-- "these books are final". Those are different claims and only the first is
-- decidable by software.
--
-- June 2026 is the evidence: frozen, therefore marked final, with 6 accounts
-- carrying a balance and 39 with no source at all. Nobody closed June. The 5th
-- of July happened.
--
-- ── What replaces it ─────────────────────────────────────────────────────────
-- `gl_account_balances.is_frozen` stops being a calendar side effect and comes
-- to mean exactly one thing: a named person asserted these books are final.
-- After this migration the ONLY writer of is_frozen is the close action in
-- lib/finance/balances/periodClose.ts, so the flag and the attribution below
-- have no way to drift apart.
--
-- An unclosed month keeps recomputing, which is correct -- it is not final. The
-- problem the time-based freeze was reaching for (a late July expense changing
-- July's balance in October) only arises AFTER someone has claimed July is
-- done, and after they have, the period is frozen.

-- ── 1. The attribution ───────────────────────────────────────────────────────
-- An event log, not a status column, and deliberately so. A period can be
-- closed, reopened because a late invoice landed, and closed again; a single
-- mutable row would keep only the last of those and quietly discard who made
-- the first call. Current state is the most recent row for the period.
create table if not exists public.balance_period_closes (
  id          uuid        primary key default gen_random_uuid(),

  -- The month being closed. Always a month end, matching gl_account_balances.
  period_end  date        not null,

  action      text        not null check (action in ('closed', 'reopened')),

  -- Who did it. Nullable ONLY so the row survives the person's account being
  -- deleted -- every write path requires a signed-in user (the close route is
  -- behind requirePermission and reads getSessionUser).
  actor_id    uuid        references auth.users(id) on delete set null,

  -- Why. Required on a reopen and refused when blank, for the same reason a
  -- skipped close task's reason is: reversing a formal assertion without
  -- saying why is indistinguishable from never having meant it. Optional on a
  -- close, where the act itself is the statement.
  reason      text,

  created_at  timestamptz not null default now(),

  constraint balance_period_closes_reopen_needs_reason
    check (action <> 'reopened' or coalesce(btrim(reason), '') <> '')
);

comment on table public.balance_period_closes is
  'Who closed or reopened each balance-sheet period, and when. The current state of a period is its most recent row; gl_account_balances.is_frozen is the enforcement of that state and is written only by the close action.';
comment on column public.balance_period_closes.action is
  'closed = a person asserted this month is final. reopened = the attributed inverse, which unfreezes the period so it recomputes again.';
comment on column public.balance_period_closes.reason is
  'Mandatory on a reopen (enforced by check constraint), optional on a close.';

-- Newest-first per period is the only access pattern: "what is the current
-- state of this month" and "who closed it".
create index if not exists balance_period_closes_period_idx
  on public.balance_period_closes (period_end, created_at desc);

-- ── 2. RLS ───────────────────────────────────────────────────────────────────
-- Same posture as every other balance-sheet table (see
-- 20260905100000_balance_sheet_snapshots.sql's long note): apply_grant_policies
-- is additive-only and bottoms out in effective_grant_level(), so this opens
-- the custom-role path and nothing else. Every application read goes through
-- the service-role admin client behind requirePermission. A SELECT matching no
-- policy returns zero rows rather than an error -- that is the intended
-- lock-down default, not a gap to fix by adding a broad read policy.
alter table public.balance_period_closes enable row level security;

select public.apply_grant_policies('balance_period_closes', 'finance.statements');

-- ── 3. Audit trail ───────────────────────────────────────────────────────────
-- The generic trigger from 20260609_baseline.sql, same as every other writable
-- finance table. This table is itself an audit record, but the trigger is what
-- catches a row being edited or deleted after the fact.
drop trigger if exists balance_period_closes_audit on public.balance_period_closes;
create trigger balance_period_closes_audit
  after insert or update or delete on public.balance_period_closes
  for each row execute function public.audit_trigger_fn();

-- ── 4. Undo the freezes nobody made ──────────────────────────────────────────
-- Every currently-frozen row was frozen by the cron's past-due-date branch,
-- because no close action existed until this migration and therefore no person
-- has ever closed a period. Leaving them frozen would carry the false claim
-- forward under a mechanism that now means something else entirely, and would
-- leave June 2026 permanently unrecomputable at 6 sourced accounts out of 45.
--
-- Unfreezing does not change a single balance. It restores these months to
-- "still open", which is what they are, and the nightly snapshot picks them up
-- again from the next run. They can then be closed properly, by a person, once
-- their accounts have sources.
update public.gl_account_balances
   set is_frozen = false
 where is_frozen = true;

-- ── 5. Verification ──────────────────────────────────────────────────────────
select 'Frozen balance rows remaining (expect 0)' as check, count(*)::text as value
  from public.gl_account_balances where is_frozen = true
union all
select 'Recorded period closes (expect 0)', count(*)::text
  from public.balance_period_closes;
