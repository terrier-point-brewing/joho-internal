-- A transfer moves beer out of ONE tank. It used to release every open tank
-- assignment the batch held, and the transfers route only put the source tank
-- back — so a batch split across two tanks vanished from the other one on the
-- floorplan. B-062 on 2026-09-28: kegging 1.5 bbl out of brite 24 dropped the
-- 23.3 bbl still fermenting in FV 23 off the floorplan.
--
-- Now only the source tank's assignment is released (none when there is no
-- source, e.g. a brewhouse turn), and arriving in a tank the batch already
-- holds is a top-up, not a collision with itself.

create or replace function public.record_batch_transfer(
  p_batch_id uuid, p_from_tank_id uuid, p_to_tank_id uuid, p_volume_bbl numeric,
  p_shrinkage_bbl numeric default 0, p_transfer_type text default 'transfer'::text,
  p_notes text default null::text, p_variation_id uuid default null::uuid,
  p_quantity numeric default null::numeric, p_created_by uuid default null::uuid)
 returns batch_transfers
 language plpgsql
 set search_path to 'public'
as $function$
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

  -- Release only the tank the beer left. The route re-inserts it when a
  -- partial draw leaves volume behind.
  if p_from_tank_id is not null then
    update public.batch_tank_assignments
       set released_at = now()
     where batch_id = p_batch_id and tank_id = p_from_tank_id and released_at is null;
  end if;

  if p_to_tank_id is not null then
    select type into v_dest_type from public.equipment where id = p_to_tank_id;
    if v_dest_type is not null then
      v_new_status := case v_dest_type
        when 'brewhouse'    then 'brewing'
        when 'fermenter'    then 'fermenting'
        when 'brite'        then 'conditioning'
        else null
      end;
      if not (v_dest_type = any(v_unconstrained)) then
        if exists (select 1 from public.batch_tank_assignments
                    where tank_id = p_to_tank_id and released_at is null and batch_id <> p_batch_id) then
          raise exception 'Destination tank is already occupied';
        end if;
        if not exists (select 1 from public.batch_tank_assignments
                        where tank_id = p_to_tank_id and released_at is null and batch_id = p_batch_id) then
          insert into public.batch_tank_assignments(batch_id, tank_id, notes)
            values (p_batch_id, p_to_tank_id, null);
        end if;
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
$function$;
