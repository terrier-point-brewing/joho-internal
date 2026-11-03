-- Hours an employee worked AT the event, out of the hours Square clocked them
-- for that day.
--
-- An employee on an event's floor is still clocked in on the taproom's Square
-- location, so the payroll grid saw them as taproom crew and gave them a share
-- of the taproom tip pool by hours — while the taproom bartender who actually
-- poured those tips got less. The manager now records the event hours on the
-- employee's payout row; the grid attributes the taproom pool over
-- (clocked − event) hours for that day (lib/payroll/dailyGrid.ts). Base pay
-- is untouched: the hours were worked, just not in the taproom.
--
-- Any employee payout may carry hours, whatever its method; the route caps
-- them at what Square clocked that day less hours already given to other
-- events, and refuses a change once the pay period is locked.
alter table public.event_tip_payouts
  add column if not exists event_hours numeric(6,2)
    check (event_hours is null or event_hours >= 0),
  add constraint event_tip_payouts_hours_are_employee
    check (event_hours is null or payee_kind = 'employee');

comment on column public.event_tip_payouts.event_hours is
  'Hours this employee worked at the event, out of their Square-clocked hours that day. Subtracted from their hours when the taproom tip pool is attributed; never from base pay.';
