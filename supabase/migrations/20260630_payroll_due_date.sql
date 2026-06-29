-- Remove anchor date concept; add due-date offset to config and due_date to periods.

alter table payroll_config
  drop column first_pay_period_start_date;

alter table payroll_config
  add column due_date_days_after_end integer not null default 3
    check (due_date_days_after_end >= 0);

alter table pay_periods
  add column due_date date;
