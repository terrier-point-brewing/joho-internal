-- Add pay period frequency to payroll_config.
-- 'biweekly' default preserves existing behaviour.
alter table payroll_config
  add column pay_period_frequency text not null default 'biweekly'
    check (pay_period_frequency in ('weekly', 'biweekly'));
