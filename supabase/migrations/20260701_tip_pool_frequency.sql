-- Add tip_pool_frequency to payroll_config
-- Controls whether tips are pooled across the whole period, per-week, or per-day.
-- The guaranteed-rate bonus is also computed at the same granularity.
ALTER TABLE payroll_config
  ADD COLUMN IF NOT EXISTS tip_pool_frequency TEXT NOT NULL DEFAULT 'biweekly';
