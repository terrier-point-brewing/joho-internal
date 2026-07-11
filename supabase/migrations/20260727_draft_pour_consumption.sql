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

-- Service-role only (populated by the sync, read by server routes via service/admin
-- or server client). No public/anon access — matches the RLS posture of the other
-- taproom operational tables.
create policy draft_pour_consumption_service_all
  on draft_pour_consumption for all
  to service_role using (true) with check (true);
