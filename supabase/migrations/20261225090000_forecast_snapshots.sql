-- ─── forecast_snapshots: what the forecast said, kept so it can be checked ───
--
-- The Financials forecast is recomputed from live data every time it is drawn,
-- so by the time a month has actually happened, what was expected of it is
-- gone. This table keeps it: one row per (month the forecast was made in, month
-- it was about, statement), holding the base-case headline figures.
--
-- Written by the forecast-snapshot scheduled job, never by a browser, and
-- always for the base case — a scenario somebody was exploring is not a
-- prediction to be held to. The job overwrites the open month's rows daily, so
-- what survives for a month is the forecast as it stood on that month's last
-- run: the best-informed expectation of the months ahead before they began.
--
-- Nothing reads this to build a statement. It is only ever compared against
-- one, on the Financials page's forecast accuracy panel.

create table if not exists public.forecast_snapshots (
  id            uuid        primary key default gen_random_uuid(),
  made_month    text        not null check (made_month ~ '^\d{4}-\d{2}$'),
  target_month  text        not null check (target_month ~ '^\d{4}-\d{2}$'),
  statement     text        not null check (statement in ('pl', 'cash_flow')),
  revenue_cents bigint      not null,
  net_cents     bigint      not null,
  shipped_bbl   numeric     not null default 0,
  made_on       date        not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint forecast_snapshots_one_per_month unique (made_month, target_month, statement),
  constraint forecast_snapshots_looks_ahead check (target_month > made_month)
);

comment on table public.forecast_snapshots is
  'Base-case Financials forecast figures as they stood in made_month, for comparison against what target_month actually came to. Written by the forecast-snapshot job; read by the forecast accuracy panel only.';
comment on column public.forecast_snapshots.revenue_cents is
  'P&L: forecast revenue. Cash flow: forecast cash in from sales.';
comment on column public.forecast_snapshots.net_cents is
  'P&L: forecast net income. Cash flow: forecast net operating cash.';

create index if not exists forecast_snapshots_target_idx
  on public.forecast_snapshots (target_month);

-- Same posture as the other finance tables: every application read goes
-- through the service-role admin client behind requirePermission, and
-- apply_grant_policies opens the custom-role path and nothing else.
alter table public.forecast_snapshots enable row level security;

select public.apply_grant_policies('forecast_snapshots', 'finance.statements');

drop trigger if exists forecast_snapshots_updated_at on public.forecast_snapshots;
create trigger forecast_snapshots_updated_at
  before insert or update on public.forecast_snapshots
  for each row execute function public.update_updated_at();
