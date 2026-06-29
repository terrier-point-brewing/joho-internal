-- Add guaranteed_min_frequency to payroll_config
-- Controls at what granularity the guaranteed-rate bonus is checked (daily/weekly/biweekly).
-- Kept separate from tip_pool_frequency so the two concerns can be configured independently.
ALTER TABLE payroll_config
  ADD COLUMN IF NOT EXISTS guaranteed_min_frequency TEXT NOT NULL DEFAULT 'biweekly';
