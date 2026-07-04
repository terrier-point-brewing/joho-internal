-- Finish removing the legacy 'packaging' batch status from the live database.
--
-- Context: 20260705_remove_packaging_status.sql was authored to drop the
-- intermediate 'packaging' status, and the application layer already reflects
-- that model (app/production/types.ts: BatchStatus has no 'packaging', and
-- EQUIPMENT_TYPE_TO_STATUS deliberately omits kegging/canning). The live
-- database, however, still carries the pre-20260705 behaviour:
--   • both record_batch_transfer overloads map a kegging/canning destination
--     to status 'packaging',
--   • the brew_batches status CHECK constraint still permits 'packaging', and
--   • B-027 was parked in 'packaging' by its kegging transfers.
--
-- Packaging (kegging/canning) is an instantaneous transaction: the packaged
-- volume is recorded via batch_transfers + cold_storage_inventory, and any
-- unpackaged remainder stays in the source tank. A batch is therefore never
-- parked in a standalone 'packaging' status — it stays 'conditioning' until it
-- is fully exhausted (then 'complete', via lib/production/batchCompletion.ts).

-- ── 1. Drop the dead kegging_detail/canning_detail overload ──────────────────
-- Its target columns (batch_transfers.kegging_detail/canning_detail) were
-- dropped in 20260628_strict_packaging_rekey, so this overload can no longer
-- insert successfully, and no code path calls it — the app uses the
-- variation_id/quantity overload exclusively (app/api/production/transfers).
drop function if exists public.record_batch_transfer(
  uuid, uuid, uuid, numeric, numeric, text, text, jsonb, jsonb, uuid
);

-- ── 2. Redefine the active overload: kegging/canning no longer set status ────
-- Removes the kegging/canning -> 'packaging' arms from the destination-type
-- mapping. Both remain in v_unconstrained, so arriving there records the
-- transfer without touching the batch's status.
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

-- ── 3. Migrate remaining 'packaging' batches back to 'conditioning' ──────────
-- (B-027, plus any other stragglers left by the stale function.)
with migrated as (
  update public.brew_batches
     set status = 'conditioning'
   where status = 'packaging'
  returning id
)
insert into public.batch_status_history (batch_id, status, note)
select id, 'conditioning',
       'Migration: packaging is an instantaneous transaction; batch remains in conditioning until exhausted'
from migrated;

-- ── 4. Tighten the status CHECK constraint to drop 'packaging' ───────────────
alter table public.brew_batches drop constraint if exists brew_batches_status_check;
alter table public.brew_batches add constraint brew_batches_status_check
  check (status in ('planning', 'brewing', 'fermenting', 'conditioning', 'complete'));
