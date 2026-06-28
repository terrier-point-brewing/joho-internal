-- Remove the 'packaging' batch status.
-- Kegging/canning transfers are tracked via batch_transfers records; the
-- intermediate 'packaging' status no longer adds signal beyond conditioning.
-- Mirrors what was already done for cold_storage.

-- ── 1. Update record_batch_transfer: kegging/canning no longer set status ──────
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

-- ── 2. Migrate existing 'packaging' rows to 'conditioning' ───────────────────
UPDATE public.brew_batches
SET status = 'conditioning'
WHERE status = 'packaging';

-- ── 3. Tighten the CHECK constraint ─────────────────────────────────────────
ALTER TABLE public.brew_batches DROP CONSTRAINT brew_batches_status_check;
ALTER TABLE public.brew_batches ADD CONSTRAINT brew_batches_status_check
  CHECK (status IN ('planning', 'brewing', 'fermenting', 'conditioning', 'complete'));
