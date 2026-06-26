-- supabase/migrations/20260628_strict_packaging_rekey.sql

alter table public.batch_transfers
  add column if not exists variation_id uuid references public.packaging_variations(id) on delete restrict,
  add column if not exists quantity numeric;

alter table public.batch_transfers
  drop column if exists kegging_detail,
  drop column if exists canning_detail;

truncate table public.cold_storage_inventory;

alter table public.cold_storage_inventory
  drop column if exists packaging_item_id,
  drop column if exists variant_label,
  add column if not exists variation_id uuid references public.packaging_variations(id) on delete restrict;

alter table public.cold_storage_inventory
  alter column variation_id set not null;

drop index if exists cold_storage_inventory_packaging_idx;
drop index if exists cold_storage_inventory_batch_variant_idx;
create index if not exists cold_storage_inventory_variation_idx on public.cold_storage_inventory(variation_id);
create unique index if not exists cold_storage_inventory_batch_variation_idx
  on public.cold_storage_inventory(batch_id, variation_id);

create or replace function public.record_batch_transfer(
  p_batch_id       uuid,
  p_from_tank_id   uuid,
  p_to_tank_id     uuid,
  p_volume_bbl     numeric,
  p_shrinkage_bbl  numeric  default 0,
  p_transfer_type  text     default 'transfer',
  p_notes          text     default null,
  p_variation_id   uuid     default null,
  p_quantity       numeric  default null,
  p_created_by     uuid     default null
) returns public.batch_transfers language plpgsql as $$
declare
  v_transfer      public.batch_transfers;
  v_dest_type     text;
  v_new_status    text;
  v_cur_status    text;
  v_unconstrained text[] := array['kegging','canning','cold_storage','backlog','loading_bay','export_bay'];
begin
  insert into public.batch_transfers(
    batch_id, from_tank_id, to_tank_id, volume_bbl, shrinkage_bbl,
    transfer_type, notes, variation_id, quantity, created_by
  ) values (
    p_batch_id, p_from_tank_id, p_to_tank_id, p_volume_bbl, coalesce(p_shrinkage_bbl, 0),
    coalesce(p_transfer_type, 'transfer'), p_notes, p_variation_id, p_quantity,
    p_created_by
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
