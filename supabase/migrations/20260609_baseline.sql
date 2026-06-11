-- Comprehensive idempotent baseline: all schema not covered by add_profiles or invoices migrations.
-- Runs after 20260608_add_profiles.sql and before 20260609_invoices.sql (b < i).

-- ── enums ─────────────────────────────────────────────────────────────────────

do $$ begin
  create type export_channel as enum ('taproom', 'distribution', 'contract_brewing');
exception when duplicate_object then null;
end $$;

-- ── sequences ─────────────────────────────────────────────────────────────────

create sequence if not exists public.audit_log_id_seq;
create sequence if not exists public.brew_batch_number_seq start 1 increment 1;

-- ── tables ────────────────────────────────────────────────────────────────────

create table if not exists public.suppliers (
  id           uuid        primary key default gen_random_uuid(),
  company_name text        not null,
  first_name   text,
  last_name    text,
  phone        text,
  address      text,
  email        text,
  notes        text,
  created_at   timestamptz not null default now()
);

create table if not exists public.contract_brewing_partners (
  id                 uuid        primary key default gen_random_uuid(),
  company_name       text        not null,
  first_name         text,
  last_name          text,
  phone              text,
  address            text,
  email              text,
  notes              text,
  created_at         timestamptz not null default now(),
  square_customer_id text
);

create table if not exists public.recipes (
  id                 uuid        primary key default gen_random_uuid(),
  beer_name          text        not null,
  expected_yield_bbl numeric,
  notes              text,
  created_at         timestamptz not null default now(),
  brewery            text,
  steps              text,
  brew_time_weeks    int,
  days_brewhouse     int,
  days_fermenter     int,
  days_brite         int
);

create table if not exists public.equipment (
  id           uuid        primary key default gen_random_uuid(),
  name         text        not null unique,
  type         text        not null,
  capacity_bbl numeric,
  notes        text,
  created_at   timestamptz not null default now(),
  grid_row     int,
  grid_col     int,
  grid_width   int         not null default 2,
  grid_height  int         not null default 3
);

create table if not exists public.workflow_templates (
  id          uuid        primary key default gen_random_uuid(),
  name        text        not null,
  description text,
  created_at  timestamptz not null default now()
);

create table if not exists public.quarterly_targets (
  id            uuid        primary key default gen_random_uuid(),
  year          int         not null,
  quarter       int         not null,
  target_cents  bigint      not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  tier          text        not null default 'target',
  unique (year, quarter, tier)
);

create table if not exists public.manual_net_sales_entries (
  id           uuid        primary key default gen_random_uuid(),
  amount_cents bigint      not null,
  label        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  start_date   date        not null,
  end_date     date        not null
);

create table if not exists public.account_requests (
  id         uuid        primary key default gen_random_uuid(),
  name       text        not null,
  email      text        not null,
  reason     text,
  status     text        not null default 'pending',
  created_at timestamptz not null default now()
);

create table if not exists public.system_settings (
  key        text        primary key,
  value      jsonb       not null,
  updated_at timestamptz not null default now(),
  updated_by uuid        references auth.users(id) on delete no action
);

create table if not exists public.packaging_items (
  id             uuid        primary key default gen_random_uuid(),
  type           text        not null,
  name           text        not null,
  unit_cost      numeric,
  volume_fl_oz   numeric,
  can_count      int,
  created_at     timestamptz not null default now(),
  is_default     bool        not null default false,
  partner_id     uuid        references contract_brewing_partners(id) on delete set null,
  supplier_id    uuid        references suppliers(id) on delete set null,
  stock_quantity numeric     not null default 0
);

create table if not exists public.ingredients (
  id              uuid        primary key default gen_random_uuid(),
  name            text        not null,
  unit            text        not null,
  cost_per_unit   numeric,
  stock_quantity  numeric     not null default 0,
  created_at      timestamptz not null default now(),
  supplier_id     uuid        references suppliers(id) on delete set null,
  partner_id      uuid        references contract_brewing_partners(id) on delete set null,
  category        text,
  alpha_acid      numeric,
  color_lovibond  numeric
);

create table if not exists public.brew_batches (
  id                    uuid        primary key default gen_random_uuid(),
  beer_name             text        not null,
  batch_number          text,
  planned_brew_date     date        not null,
  volume_bbl            numeric     not null,
  status                text        not null,
  notes                 text,
  created_at            timestamptz not null default now(),
  turns                 int         not null default 1,
  recipe_id             uuid        references recipes(id) on delete set null,
  expected_delivery_date date,
  ibu                   numeric,
  color_srm             numeric,
  original_gravity      numeric,
  final_gravity         numeric,
  dissolved_oxygen_ppb  numeric,
  turns_completed       int         not null default 0,
  square_invoice_id     text
);

create table if not exists public.commitments (
  id                  uuid        primary key default gen_random_uuid(),
  recipe_id           uuid        references recipes(id) on delete set null,
  beer_style          text        not null,
  partner_id          uuid        references contract_brewing_partners(id) on delete set null,
  volume_bbl          numeric     not null,
  desired_delivery_date date,
  status              text        not null default 'open',
  notes               text,
  created_at          timestamptz not null default now(),
  packaging_item_id   uuid        references packaging_items(id) on delete set null,
  packaging_qty       numeric,
  channel             text        not null default 'contract_brewing',
  cadence             text        not null default 'one_time',
  recurrence          text,
  start_date          date,
  end_date            date,
  received_on         date,
  last_edited_on      timestamptz,
  locked_on           date
);

create table if not exists public.safety_stock_floors (
  id             uuid    primary key default gen_random_uuid(),
  recipe_id      uuid    not null references recipes(id) on delete cascade,
  packaging      text    not null,
  floor_quantity numeric not null default 0,
  created_at     timestamptz not null default now(),
  unique (recipe_id, packaging)
);

create table if not exists public.recipe_ingredients (
  id                 uuid        primary key default gen_random_uuid(),
  recipe_id          uuid        not null references recipes(id) on delete cascade,
  ingredient_id      uuid        not null references ingredients(id) on delete restrict,
  quantity_per_bbl   numeric     not null,
  created_at         timestamptz not null default now()
);

create table if not exists public.recipe_brew_activity_templates (
  id          uuid        primary key default gen_random_uuid(),
  recipe_id   uuid        not null references recipes(id) on delete cascade,
  sort_order  int         not null default 0,
  activity    text        not null,
  time_label  text,
  temp        numeric,
  amount      numeric,
  created_at  timestamptz not null default now(),
  vsp         numeric,
  temp_unit   text        not null default 'F',
  amount_unit text
);

create table if not exists public.recipe_square_links (
  id                  uuid        primary key default gen_random_uuid(),
  recipe_id           uuid        not null references recipes(id) on delete cascade,
  packaging           text        not null,
  square_variation_id text        not null,
  square_item_id      text,
  created_at          timestamptz not null default now(),
  variation_name      text,
  item_name           text,
  packaging_item_id   uuid        references packaging_items(id) on delete set null
);

create table if not exists public.workflow_template_steps (
  id            uuid        primary key default gen_random_uuid(),
  template_id   uuid        not null references workflow_templates(id) on delete cascade,
  step_order    int         not null,
  equipment_id  uuid        not null references equipment(id) on delete cascade,
  duration_days int,
  notes         text,
  created_at    timestamptz not null default now()
);

create table if not exists public.audit_log (
  id          bigint      primary key default nextval('audit_log_id_seq'::regclass),
  table_name  text        not null,
  record_id   text,
  operation   text        not null,
  user_id     uuid,
  changed_at  timestamptz not null default now(),
  old_data    jsonb,
  new_data    jsonb
);

create table if not exists public.batch_schedule_entries (
  id                  uuid        primary key default gen_random_uuid(),
  batch_id            uuid        not null references brew_batches(id) on delete cascade,
  equipment_id        uuid        references equipment(id) on delete set null,
  stage               text        not null,
  planned_start       timestamptz not null,
  planned_end         timestamptz not null,
  actual_start        timestamptz,
  actual_end          timestamptz,
  notes               text,
  created_at          timestamptz default now(),
  updated_at          timestamptz default now(),
  cancelled_at        timestamptz,
  cancellation_reason text,
  step_order          int,
  completed_at        timestamptz
);

create table if not exists public.batch_status_history (
  id         uuid        primary key default gen_random_uuid(),
  batch_id   uuid        not null references brew_batches(id) on delete cascade,
  status     text        not null,
  note       text,
  changed_at timestamptz not null default now()
);

create table if not exists public.batch_tank_assignments (
  id          uuid        primary key default gen_random_uuid(),
  batch_id    uuid        not null references brew_batches(id) on delete cascade,
  tank_id     uuid        not null references equipment(id) on delete cascade,
  assigned_at timestamptz not null default now(),
  released_at timestamptz,
  notes       text
);

create table if not exists public.batch_transfers (
  id            uuid        primary key default gen_random_uuid(),
  batch_id      uuid        not null references brew_batches(id) on delete cascade,
  from_tank_id  uuid        references equipment(id) on delete set null,
  to_tank_id    uuid        references equipment(id) on delete set null,
  volume_bbl    numeric     not null,
  shrinkage_bbl numeric     not null default 0,
  transfer_type text        not null default 'transfer',
  notes         text,
  kegging_detail  jsonb,
  canning_detail  jsonb,
  transferred_at  timestamptz not null default now(),
  export_detail   jsonb
);

create table if not exists public.stock_adjustments (
  id               uuid        primary key default gen_random_uuid(),
  ingredient_id    uuid        not null references ingredients(id) on delete cascade,
  quantity         numeric     not null,
  type             text        not null,
  note             text,
  batch_id         uuid        references brew_batches(id) on delete set null,
  created_at       timestamptz not null default now(),
  cost_per_unit    numeric,
  total_value_change numeric,
  shipping_cost    numeric,
  unit             text
);

create table if not exists public.batch_allocations (
  id                  uuid    primary key default gen_random_uuid(),
  batch_id            uuid    not null references brew_batches(id) on delete cascade,
  channel             text    not null check (channel in ('taproom','distribution','contract_brewing','safety_stock')),
  contract_request_id uuid    references commitments(id) on delete set null,
  partner_id          uuid    references contract_brewing_partners(id) on delete set null,
  label               text,
  percentage          numeric not null check (percentage > 0 and percentage <= 100),
  locked              bool    not null default false,
  lock_reason         text    check (lock_reason is null or lock_reason in ('deposit_paid','contract_signed')),
  locked_at           timestamptz,
  notes               text,
  created_at          timestamptz not null default now()
);

create table if not exists public.batch_exports (
  id                      uuid        primary key default gen_random_uuid(),
  batch_id                uuid        not null references brew_batches(id) on delete cascade,
  channel                 export_channel not null,
  recipient_id            uuid        references contract_brewing_partners(id) on delete set null,
  recipient_name          text,
  product_type            text        not null,
  quantity                numeric     not null,
  unit                    text        not null default 'units',
  volume_bbl              numeric,
  notes                   text,
  square_catalog_item_id  text,
  square_location_id      text,
  square_synced_at        timestamptz,
  created_at              timestamptz default now(),
  federal_excise_tax_usd  numeric,
  state_excise_tax_usd    numeric,
  transfer_id             uuid        references batch_transfers(id) on delete set null
);

create table if not exists public.batch_brew_activity_log (
  id          uuid        primary key default gen_random_uuid(),
  batch_id    uuid        not null references brew_batches(id) on delete cascade,
  sort_order  int         not null default 0,
  activity    text        not null,
  time_label  text,
  temp        numeric,
  amount      numeric,
  created_at  timestamptz not null default now(),
  vsp         numeric,
  temp_unit   text        not null default 'F',
  amount_unit text,
  template_id uuid        references recipe_brew_activity_templates(id) on delete set null
);

create table if not exists public.brew_inventory_adjustments (
  id                  uuid        primary key default gen_random_uuid(),
  batch_transfer_id   uuid        not null references batch_transfers(id) on delete cascade,
  quantity            numeric     not null,
  type                text        not null,
  note                text,
  created_at          timestamptz not null default now(),
  product_label       text,
  product_type        text,
  unit                text
);

create table if not exists public.packaging_stock_adjustments (
  id                  uuid        primary key default gen_random_uuid(),
  packaging_item_id   uuid        not null references packaging_items(id) on delete cascade,
  quantity            numeric     not null,
  type                text        not null,
  note                text,
  cost_per_unit       numeric,
  total_value_change  numeric,
  created_at          timestamptz not null default now(),
  batch_transfer_id   uuid        references batch_transfers(id) on delete no action,
  shipping_cost       numeric
);

-- ── functions ─────────────────────────────────────────────────────────────────

create or replace function public.get_my_role()
  returns user_role language sql stable security definer set search_path = public as $$
  select role from profiles where id = auth.uid();
$$;

create or replace function public.update_updated_at()
  returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.adjust_ingredient_stock(p_id uuid, p_delta numeric)
  returns void language sql set search_path = public as $$
  update ingredients set stock_quantity = stock_quantity + p_delta where id = p_id;
$$;

create or replace function public.audit_trigger_fn()
  returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_user_id  uuid;
  v_record_id text;
begin
  v_user_id := coalesce(
    auth.uid(),
    nullif(current_setting('app.audit_user_id', true), '')::uuid
  );
  v_record_id := case when tg_op = 'DELETE' then (old.id)::text else (new.id)::text end;
  insert into audit_log (table_name, record_id, operation, user_id, old_data, new_data)
  values (
    tg_table_name, v_record_id, tg_op, v_user_id,
    case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) else null end,
    case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) else null end
  );
  return coalesce(new, old);
end;
$$;

create or replace function public.set_batch_number()
  returns trigger language plpgsql set search_path = public as $$
begin
  if new.batch_number is null or new.batch_number = '' then
    new.batch_number := 'B-' || lpad(nextval('brew_batch_number_seq')::text, 3, '0');
  end if;
  return new;
end;
$$;

create or replace function public.create_batch_with_consumption(
  p_beer_name             text,
  p_planned_brew_date     date,
  p_expected_delivery_date date,
  p_volume_bbl            numeric,
  p_turns                 integer,
  p_status                text,
  p_notes                 text,
  p_recipe_id             uuid
) returns brew_batches language plpgsql as $$
declare
  v_batch public.brew_batches;
begin
  insert into public.brew_batches(
    beer_name, planned_brew_date, expected_delivery_date,
    volume_bbl, turns, status, notes, recipe_id
  ) values (
    p_beer_name, p_planned_brew_date, p_expected_delivery_date,
    p_volume_bbl, coalesce(p_turns, 1), coalesce(p_status, 'planning'), p_notes, p_recipe_id
  ) returning * into v_batch;
  insert into public.batch_status_history(batch_id, status, note)
    values (v_batch.id, v_batch.status, 'Batch created');
  return v_batch;
end;
$$;

create or replace function public.record_batch_transfer(
  p_batch_id      uuid,
  p_from_tank_id  uuid,
  p_to_tank_id    uuid,
  p_volume_bbl    numeric,
  p_shrinkage_bbl numeric  default 0,
  p_transfer_type text     default 'transfer',
  p_notes         text     default null,
  p_kegging_detail jsonb   default null,
  p_canning_detail jsonb   default null
) returns batch_transfers language plpgsql as $$
declare
  v_transfer      public.batch_transfers;
  v_dest_type     text;
  v_new_status    text;
  v_cur_status    text;
  v_unconstrained text[] := array['kegging','canning','cold_storage','backlog','loading_bay','export_bay'];
begin
  insert into public.batch_transfers(
    batch_id, from_tank_id, to_tank_id, volume_bbl, shrinkage_bbl,
    transfer_type, notes, kegging_detail, canning_detail
  ) values (
    p_batch_id, p_from_tank_id, p_to_tank_id, p_volume_bbl, coalesce(p_shrinkage_bbl, 0),
    coalesce(p_transfer_type, 'transfer'), p_notes, p_kegging_detail, p_canning_detail
  ) returning * into v_transfer;
  update public.batch_tank_assignments
     set released_at = now()
   where batch_id = p_batch_id and released_at is null;
  if p_to_tank_id is not null then
    select type into v_dest_type from public.equipment where id = p_to_tank_id;
    if v_dest_type is not null then
      v_new_status := case v_dest_type
        when 'brewhouse'    then 'brewing'
        when 'fermenter'    then 'fermenting'
        when 'brite'        then 'conditioning'
        when 'kegging'      then 'packaging'
        when 'canning'      then 'packaging'
        when 'cold_storage' then 'archived'
        else null
      end;
      if not (v_dest_type = any(v_unconstrained)) then
        if exists (select 1 from public.batch_tank_assignments where tank_id = p_to_tank_id and released_at is null) then
          raise exception 'Destination tank is already occupied';
        end if;
        insert into public.batch_tank_assignments(batch_id, tank_id, notes)
          values (p_batch_id, p_to_tank_id, null);
      end if;
      if v_new_status is not null then
        select status into v_cur_status from public.brew_batches where id = p_batch_id;
        if v_cur_status is distinct from v_new_status then
          update public.brew_batches set status = v_new_status where id = p_batch_id;
          insert into public.batch_status_history(batch_id, status, note)
            values (p_batch_id, v_new_status, 'Auto: transferred to ' || coalesce(p_transfer_type, 'transfer'));
        end if;
      end if;
    end if;
  end if;
  return v_transfer;
end;
$$;

-- ── triggers ──────────────────────────────────────────────────────────────────

drop trigger if exists trg_set_batch_number on public.brew_batches;
create trigger trg_set_batch_number
  before insert on public.brew_batches
  for each row execute function set_batch_number();

drop trigger if exists manual_net_sales_entries_updated_at on public.manual_net_sales_entries;
create trigger manual_net_sales_entries_updated_at
  before update on public.manual_net_sales_entries
  for each row execute function update_updated_at();

drop trigger if exists quarterly_targets_updated_at on public.quarterly_targets;
create trigger quarterly_targets_updated_at
  before update on public.quarterly_targets
  for each row execute function update_updated_at();

-- audit triggers

drop trigger if exists audit_batch_allocations on public.batch_allocations;
create trigger audit_batch_allocations
  after insert or update or delete on public.batch_allocations
  for each row execute function audit_trigger_fn();

drop trigger if exists audit_batch_brew_activity_log on public.batch_brew_activity_log;
create trigger audit_batch_brew_activity_log
  after insert or update or delete on public.batch_brew_activity_log
  for each row execute function audit_trigger_fn();

drop trigger if exists audit_batch_exports on public.batch_exports;
create trigger audit_batch_exports
  after insert or update or delete on public.batch_exports
  for each row execute function audit_trigger_fn();

drop trigger if exists audit_batch_schedule_entries on public.batch_schedule_entries;
create trigger audit_batch_schedule_entries
  after insert or update or delete on public.batch_schedule_entries
  for each row execute function audit_trigger_fn();

drop trigger if exists audit_batch_status_history on public.batch_status_history;
create trigger audit_batch_status_history
  after insert or update or delete on public.batch_status_history
  for each row execute function audit_trigger_fn();

drop trigger if exists audit_batch_tank_assignments on public.batch_tank_assignments;
create trigger audit_batch_tank_assignments
  after insert or update or delete on public.batch_tank_assignments
  for each row execute function audit_trigger_fn();

drop trigger if exists audit_batch_transfers on public.batch_transfers;
create trigger audit_batch_transfers
  after insert or update or delete on public.batch_transfers
  for each row execute function audit_trigger_fn();

drop trigger if exists audit_brew_batches on public.brew_batches;
create trigger audit_brew_batches
  after insert or update or delete on public.brew_batches
  for each row execute function audit_trigger_fn();

drop trigger if exists audit_brew_inventory_adjustments on public.brew_inventory_adjustments;
create trigger audit_brew_inventory_adjustments
  after insert or update or delete on public.brew_inventory_adjustments
  for each row execute function audit_trigger_fn();

drop trigger if exists audit_commitments on public.commitments;
create trigger audit_commitments
  after insert or update or delete on public.commitments
  for each row execute function audit_trigger_fn();

drop trigger if exists audit_contract_brewing_partners on public.contract_brewing_partners;
create trigger audit_contract_brewing_partners
  after insert or update or delete on public.contract_brewing_partners
  for each row execute function audit_trigger_fn();

drop trigger if exists audit_equipment on public.equipment;
create trigger audit_equipment
  after insert or update or delete on public.equipment
  for each row execute function audit_trigger_fn();

drop trigger if exists audit_ingredients on public.ingredients;
create trigger audit_ingredients
  after insert or update or delete on public.ingredients
  for each row execute function audit_trigger_fn();

drop trigger if exists audit_manual_net_sales_entries on public.manual_net_sales_entries;
create trigger audit_manual_net_sales_entries
  after insert or update or delete on public.manual_net_sales_entries
  for each row execute function audit_trigger_fn();

drop trigger if exists audit_packaging_items on public.packaging_items;
create trigger audit_packaging_items
  after insert or update or delete on public.packaging_items
  for each row execute function audit_trigger_fn();

drop trigger if exists audit_packaging_stock_adjustments on public.packaging_stock_adjustments;
create trigger audit_packaging_stock_adjustments
  after insert or update or delete on public.packaging_stock_adjustments
  for each row execute function audit_trigger_fn();

drop trigger if exists audit_quarterly_targets on public.quarterly_targets;
create trigger audit_quarterly_targets
  after insert or update or delete on public.quarterly_targets
  for each row execute function audit_trigger_fn();

drop trigger if exists audit_recipe_brew_activity_templates on public.recipe_brew_activity_templates;
create trigger audit_recipe_brew_activity_templates
  after insert or update or delete on public.recipe_brew_activity_templates
  for each row execute function audit_trigger_fn();

drop trigger if exists audit_recipe_ingredients on public.recipe_ingredients;
create trigger audit_recipe_ingredients
  after insert or update or delete on public.recipe_ingredients
  for each row execute function audit_trigger_fn();

drop trigger if exists audit_recipe_square_links on public.recipe_square_links;
create trigger audit_recipe_square_links
  after insert or update or delete on public.recipe_square_links
  for each row execute function audit_trigger_fn();

drop trigger if exists audit_recipes on public.recipes;
create trigger audit_recipes
  after insert or update or delete on public.recipes
  for each row execute function audit_trigger_fn();

drop trigger if exists audit_safety_stock_floors on public.safety_stock_floors;
create trigger audit_safety_stock_floors
  after insert or update or delete on public.safety_stock_floors
  for each row execute function audit_trigger_fn();

drop trigger if exists audit_stock_adjustments on public.stock_adjustments;
create trigger audit_stock_adjustments
  after insert or update or delete on public.stock_adjustments
  for each row execute function audit_trigger_fn();

drop trigger if exists audit_suppliers on public.suppliers;
create trigger audit_suppliers
  after insert or update or delete on public.suppliers
  for each row execute function audit_trigger_fn();

drop trigger if exists audit_workflow_template_steps on public.workflow_template_steps;
create trigger audit_workflow_template_steps
  after insert or update or delete on public.workflow_template_steps
  for each row execute function audit_trigger_fn();

drop trigger if exists audit_workflow_templates on public.workflow_templates;
create trigger audit_workflow_templates
  after insert or update or delete on public.workflow_templates
  for each row execute function audit_trigger_fn();

-- ── indexes ───────────────────────────────────────────────────────────────────

create index if not exists batch_allocations_batch_id_idx on batch_allocations(batch_id);
create index if not exists batch_allocations_partner_id_idx on batch_allocations(partner_id);
create index if not exists batch_brew_activity_log_batch_id_idx on batch_brew_activity_log(batch_id);
create index if not exists batch_exports_batch_id_idx on batch_exports(batch_id);
create index if not exists batch_exports_channel_idx on batch_exports(channel);
create index if not exists batch_schedule_entries_batch_id_idx on batch_schedule_entries(batch_id);
create index if not exists batch_schedule_entries_equipment_id_idx on batch_schedule_entries(equipment_id);
create index if not exists batch_schedule_entries_planned_start_idx on batch_schedule_entries(planned_start);
create index if not exists idx_bse_equipment_active on batch_schedule_entries(equipment_id) where cancelled_at is null;
create unique index if not exists one_active_assignment_per_tank on batch_tank_assignments(tank_id) where released_at is null;
create index if not exists brew_inv_adj_transfer_idx on brew_inventory_adjustments(batch_transfer_id);
create index if not exists pkg_stock_adj_item_idx on packaging_stock_adjustments(packaging_item_id);
create index if not exists recipe_brew_activity_templates_recipe_id_idx on recipe_brew_activity_templates(recipe_id);
create unique index if not exists recipe_square_links_recipe_draft_uniq on recipe_square_links(recipe_id, packaging) where packaging_item_id is null;
create unique index if not exists recipe_square_links_recipe_packaging_item_uniq on recipe_square_links(recipe_id, packaging_item_id) where packaging_item_id is not null;
create unique index if not exists packaging_items_one_default_per_nonkeg on packaging_items(type) where is_default = true and type <> 'keg';

-- ── row level security ────────────────────────────────────────────────────────

alter table public.account_requests enable row level security;

drop policy if exists "Anyone can submit a request" on public.account_requests;
create policy "Anyone can submit a request"
  on public.account_requests for insert
  with check (true);

drop policy if exists "Admins can manage requests" on public.account_requests;
create policy "Admins can manage requests"
  on public.account_requests for all
  using (exists (select 1 from profiles p where p.id = auth.uid() and p.role = 'admin'));

alter table public.audit_log enable row level security;

drop policy if exists "Admins can read audit log" on public.audit_log;
create policy "Admins can read audit log"
  on public.audit_log for select
  using (get_my_role() = 'admin'::user_role);

alter table public.system_settings enable row level security;

drop policy if exists "authenticated users can read system_settings" on public.system_settings;
create policy "authenticated users can read system_settings"
  on public.system_settings for select
  using (true);

-- NOTE: writes to system_settings are restricted to the service role only.
-- App-side writes must use the Supabase service client (not the anon/user client).
drop policy if exists "service role can write system_settings" on public.system_settings;
create policy "service role can write system_settings"
  on public.system_settings for all
  using (true);

-- ── seed data ─────────────────────────────────────────────────────────────────

insert into system_settings (key, value) values ('floorplan_grid', '{"cols": 24, "rows": 16}')
on conflict (key) do nothing;
