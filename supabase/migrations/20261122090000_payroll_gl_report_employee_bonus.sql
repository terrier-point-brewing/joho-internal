-- Per-employee Bonus sub-row total from the Gusto payroll journal. The Bonus
-- amount still folds into gross_amount_cents (it is wage expense); this column
-- exists so the taproom check can recognise a bonus Gusto booked under a
-- non-taproom department for someone the app pays through the bartender table.
alter table public.payroll_gl_report_employees
  add column if not exists bonus_cents bigint not null default 0;
