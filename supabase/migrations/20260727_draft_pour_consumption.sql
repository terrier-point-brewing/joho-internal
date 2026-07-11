-- Daily operational record of actual draft POUR consumption (fl oz), per recipe.
-- This is the taproom operational lens (sell-through / demand / shrinkage) and is
-- intentionally separate from the whole-keg accounting lens in export_transactions.
create table if not exists draft_pour_consumption (
  recipe_id     uuid not null references recipes(id) on delete cascade,
  business_date date not null,
  fl_oz         numeric not null default 0,
  pour_units    numeric not null default 0,
  updated_at    timestamptz not null default now(),
  primary key (recipe_id, business_date)
);

create index if not exists draft_pour_consumption_date_idx
  on draft_pour_consumption (business_date);

alter table draft_pour_consumption enable row level security;

-- Operational table: read + write by the app's authenticated server client
-- (draft-stats + demand-calendar read it; the manual-sync route writes it),
-- matching the RLS posture of tap_assignments. The cron/webhook sync uses the
-- service-role client, which bypasses RLS regardless.
create policy draft_pour_consumption_authenticated_all
  on draft_pour_consumption for all
  to authenticated using (true) with check (true);
