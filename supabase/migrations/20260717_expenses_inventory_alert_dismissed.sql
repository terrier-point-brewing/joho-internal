-- Production-inventory alert dismissal flag on expenses.
--
-- Expenses coded to chart-of-accounts 5110/5120 (production ingredients/packaging)
-- require a matching production-inventory update. The Expenses tab shows an alert
-- banner for these; ticking its Dismiss checkbox sets this flag so the row leaves
-- the banner. It is purely a UI acknowledgement — no bearing on P&L / mapping.
--
-- Additive and default-false — historical rows read as not-dismissed. The Ramp sync
-- upsert never includes this column, so re-syncs leave dismissals untouched. Safe to
-- re-run.

alter table public.expenses
  add column if not exists inventory_alert_dismissed boolean not null default false;
