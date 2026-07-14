-- supabase/migrations/20260713_payroll_declared_cash_tips.sql
-- Move to declared-per-person cash tips; add configurable Gusto reporting ratio.

-- Remove the obsolete cash-sales estimator knob.
alter table payroll_config drop column cash_tips_rate;

-- Configurable Gusto reporting ratio (N:1). reported = round(actual / divisor).
alter table payroll_config
  add column reported_cash_tips_divisor integer not null default 10
    check (reported_cash_tips_divisor > 0);

-- Per-entry reported cash tips (computed default + admin override), snapshotted at lock.
alter table payroll_entries
  add column reported_cash_tips_cents     integer,
  add column adj_reported_cash_tips_cents integer;
