-- Exclude one day's card-tip pool from payroll, on the record.
--
-- A card tip can land on a day when nobody tip-eligible worked (a salaried
-- worker rang a sale). The owner's rule is that salaried staff never receive
-- tips, so that pool must not be paid to anyone through payroll — but the lock
-- gate (lib/payroll/dailyGrid.ts unattributedBuckets) rightly refuses to
-- snapshot a pool that never landed on an employee. This table is the audited
-- answer: an admin excludes the day with a reason, the gate treats the day's
-- pool as 0 to attribute, and the money stays in GL 2310 Undistributed Tips
-- until finance reclasses it.
--
-- amount_cents is a snapshot of the day's pool at the time of exclusion. If
-- the live pool later differs (late refund, re-sync), the grid surfaces the
-- drift and the lock refuses until the exclusion is re-saved — never absorbed.
create table if not exists public.payroll_tip_day_exclusions (
  id            uuid primary key default gen_random_uuid(),
  pay_period_id uuid not null references public.pay_periods(id) on delete cascade,
  work_date     date not null,
  amount_cents  integer not null check (amount_cents >= 0),
  reason        text not null check (length(btrim(reason)) > 0),
  created_by    uuid,
  created_at    timestamptz not null default now(),
  unique (pay_period_id, work_date)
);

comment on table public.payroll_tip_day_exclusions is
  'Days whose card-tip pool is deliberately kept out of payroll (nobody tip-eligible worked). amount_cents snapshots the pool at exclusion time; the money stays in GL 2310 for finance to reclass.';

-- Lock-time snapshot of the excluded total, so period readers can tell "pooled
-- but never paid out" from "paid out" without recomputing from Square.
alter table public.pay_periods
  add column if not exists excluded_tips_cents integer;
comment on column public.pay_periods.excluded_tips_cents is
  'Σ payroll_tip_day_exclusions.amount_cents frozen at lock; null while open. Stays in GL 2310, never paid through payroll.';

-- RLS: same shape as payroll_shift_overrides (20260821) plus the grant-aware
-- pair from 20260822, whose DO-block array also lists this table.
alter table public.payroll_tip_day_exclusions enable row level security;

drop policy if exists "payroll readers" on public.payroll_tip_day_exclusions;
create policy "payroll readers" on public.payroll_tip_day_exclusions
  for all to authenticated
  using ( public.get_my_role() = any (public.payroll_reader_roles()) )
  with check ( public.get_my_role() = any (public.payroll_reader_roles()) );

select public.apply_grant_policies('payroll_tip_day_exclusions', 'payroll');
