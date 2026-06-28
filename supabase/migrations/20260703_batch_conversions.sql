-- ─── batch_conversions: first-class table for batch-to-batch conversion links ──

create table batch_conversions (
  id                  uuid primary key default gen_random_uuid(),
  source_batch_id     uuid not null references brew_batches(id),
  target_batch_id     uuid not null references brew_batches(id),
  source_equipment_id uuid references equipment(id),
  volume_bbl          numeric(8,3) not null,
  planned_date        date,
  converted_at        timestamptz,
  notes               text,
  created_at          timestamptz not null default now(),
  unique (source_batch_id, target_batch_id)
);

-- ─── Migrate existing planned_conversion schedule entries ──────────────────────
-- Each planned_conversion entry encodes { beer_name, child_batch_id } in notes
-- JSON. Migrate to batch_conversions rows, then delete the entries.

do $$
declare
  r record;
  parsed jsonb;
  child_id uuid;
begin
  for r in
    select id, batch_id, equipment_id, volume_bbl, planned_start, notes
    from batch_schedule_entries
    where stage = 'planned_conversion'
      and cancelled_at is null
  loop
    begin
      parsed := r.notes::jsonb;
      child_id := (parsed->>'child_batch_id')::uuid;
    exception when others then
      child_id := null;
    end;

    if child_id is not null then
      -- Skip if this pair already exists (idempotent re-run safety)
      if not exists (
        select 1 from batch_conversions
        where source_batch_id = r.batch_id and target_batch_id = child_id
      ) then
        insert into batch_conversions
          (source_batch_id, target_batch_id, source_equipment_id, volume_bbl, planned_date)
        values (
          r.batch_id,
          child_id,
          r.equipment_id,
          coalesce(r.volume_bbl, (select volume_bbl from brew_batches where id = child_id), 0),
          r.planned_start::date
        );
      end if;
    end if;
  end loop;
end;
$$;

-- Delete all planned_conversion schedule entries (migrated above)
delete from batch_schedule_entries where stage = 'planned_conversion';

-- ─── Clean up old conversion-channel allocations ──────────────────────────────
delete from batch_allocations where channel = 'conversion';

-- ─── Drop conversion_target_recipe_id from batch_allocations ──────────────────
alter table batch_allocations
  drop column if exists conversion_target_recipe_id;

-- ─── Update channel CHECK constraint (if present) to exclude 'conversion' ─────
-- Name may vary; drop by predicate and re-add.
do $$
declare
  cname text;
begin
  select conname into cname
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  join pg_namespace n on n.oid = t.relnamespace
  where t.relname = 'batch_allocations'
    and n.nspname = 'public'
    and c.contype = 'c'
    and pg_get_constraintdef(c.oid) like '%conversion%'
    and pg_get_constraintdef(c.oid) like '%channel%';

  if cname is not null then
    execute 'alter table batch_allocations drop constraint ' || quote_ident(cname);
  end if;
end;
$$;

-- Re-add channel constraint without 'conversion'
alter table batch_allocations
  add constraint batch_allocations_channel_check
  check (channel in ('taproom', 'distribution', 'contract_brewing', 'safety_stock'));

-- ─── Clear stale converted_from_batch_id links ────────────────────────────────
-- B-030 and B-038 have converted_from_batch_id set from the old UI. Null them
-- out so they can be re-established via the new ConvertPanel (which writes both
-- a batch_conversions row and re-stamps converted_from_batch_id on the target).
update brew_batches
  set converted_from_batch_id = null
  where batch_number in ('B-030', 'B-038')
    and converted_from_batch_id is not null;
