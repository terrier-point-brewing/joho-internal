-- Event tips are settled from the event, never through the taproom tip pool.
--
-- The taproom is open while an event runs, and events are staffed partly by
-- volunteers, so an event's card tips must not blend into the day's pool that
-- the clocked-in taproom crew splits by hours. The payroll grid now carves
-- every event-ticket tip (a ticket with an Event Pour, closed inside the
-- event's buffered window) out of the day's pool at source
-- (lib/square/payroll.ts aggregateDailyTips). What is carved out is settled
-- here, from the Events tab, one row per payee:
--
--   * an employee paid through payroll  -> lands on their Paycheck Tips in the
--     pay period containing the event (lib/payroll/dailyGrid.ts), and reaches
--     GL 2310 through Gusto's postings like any other paycheck tip;
--   * anyone paid in cash, comped beer, or settled some other way -> relieves
--     GL 2310 through the eventTipSettlements provider, on settled_on.
--
-- A volunteer can only be settled outside payroll; a payroll payout can only
-- name an hourly tipped employee (the owner's rule that salaried staff never
-- receive tips). The route enforces both; the CHECKs keep the table honest.
create table if not exists public.event_tip_payouts (
  id            uuid primary key default gen_random_uuid(),
  event_id      uuid not null references public.events(id) on delete cascade,
  payee_kind    text not null check (payee_kind in ('employee', 'volunteer')),
  employee_id   uuid references public.employees(id) on delete restrict,
  payee_name    text,
  method        text not null check (method in ('payroll', 'cash', 'comp', 'other')),
  amount_cents  integer not null check (amount_cents > 0),
  -- The day the settlement happened (cash handed over, beer comped). Drives
  -- which month GL 2310 is relieved in. Payroll payouts settle on the event's
  -- day through payroll instead, so this stays null for them.
  settled_on    date,
  note          text,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  constraint event_tip_payouts_payee_shape check (
    (payee_kind = 'employee'  and employee_id is not null)
    or
    (payee_kind = 'volunteer' and employee_id is null and length(btrim(coalesce(payee_name, ''))) > 0)
  ),
  constraint event_tip_payouts_payroll_is_employee check (
    method <> 'payroll' or payee_kind = 'employee'
  ),
  constraint event_tip_payouts_settled_on_shape check (
    (method = 'payroll') = (settled_on is null)
  )
);

create index if not exists event_tip_payouts_event_idx on public.event_tip_payouts (event_id);
create index if not exists event_tip_payouts_employee_idx on public.event_tip_payouts (employee_id) where employee_id is not null;

comment on table public.event_tip_payouts is
  'How an event''s tips were settled, one row per payee. Event tips are carved out of the taproom tip pool at source; payroll rows land on the employee''s Paycheck Tips, every other method relieves GL 2310 on settled_on.';

-- RLS: the Events tab's own policies are role-based on profiles (20260614);
-- this table follows the events table plus the grant-aware pair, scoped to
-- taproom.performance like the tab that writes it.
alter table public.event_tip_payouts enable row level security;

drop policy if exists "authenticated read event tip payouts" on public.event_tip_payouts;
create policy "authenticated read event tip payouts"
  on public.event_tip_payouts for select
  using (auth.role() = 'authenticated');

drop policy if exists "manager write event tip payouts" on public.event_tip_payouts;
create policy "manager write event tip payouts"
  on public.event_tip_payouts for all
  using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('manager', 'admin'))
  )
  with check (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('manager', 'admin'))
  );

select public.apply_grant_policies('event_tip_payouts', 'taproom.performance');
