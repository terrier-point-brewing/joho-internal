-- Convert kegs (or cans) ALREADY in cold storage from one recipe to another.
--
-- The in-keg conversion (20261103090000) covers the dose that goes in at the
-- filler: the tank holds Carolina Mule, the kegs come out Transfusion Lager.
-- This covers the dose that goes in later: the kegs sat in the cold room as
-- Mule for a fortnight, then got re-dosed. Same commercial shape as an in-keg
-- run — the beer becomes a conversion CHILD batch so it can be allocated,
-- credited, deposit-billed and costed — but the stock itself never leaves the
-- cold room, so the only inventory movement is from one lot to another.
--
-- WHAT THE APP WRITES AROUND THIS (lib/production/coldStorageRecipeConversion):
--
--   1. a packaging REVERSAL on the source (kegging/canning, negative volume
--      and quantity). Every reader of "what did this batch package" is a
--      SUM over kegging/canning rows — batch_exhaustion, commitment
--      fulfillment, the partner portal, intake demand, batch costing — and a
--      negative row nets each of them down by exactly the beer that stopped
--      being this recipe, without any of them learning a new row shape.
--   2. a CONVERSION row on the source, to_batch_id = the child, no tanks: the
--      kegs were never in a vessel. Costing follows it (the child inherits the
--      parent's cost per bbl for that volume) and the exhaustion view counts it
--      as converted, so kegged + converted still ties to the batch's volume.
--   3. a packaging row on the CHILD, from nowhere to nowhere — the same shape
--      an in-keg child's rows take, which computeLocationBreakdown already
--      reads as finished goods.
--   4. this function, which moves the units between lots atomically.
--
-- WHY A FUNCTION. The lot is locked, the count is checked against what is
-- actually there, the source lot is drawn down (deleted at zero, like a
-- transform) and the child's lot is created or topped up — one statement, so
-- a bad count rolls everything back and a retry cannot double-move.

create or replace function public.move_cold_storage_lot_to_batch(
  p_lot_id uuid,
  p_units numeric,
  p_to_batch_id uuid,
  p_to_recipe_id uuid,
  p_source_transfer_id uuid default null
)
returns public.cold_storage_inventory
language plpgsql
set search_path to 'public'
as $function$
declare
  v_lot       public.cold_storage_inventory;
  v_remaining numeric;
  v_out       public.cold_storage_inventory;
  c_dust constant numeric := 0.0001;
begin
  if p_units is null or p_units <= 0 then
    raise exception 'units must be positive' using errcode = '22023';
  end if;
  if p_to_batch_id is null or p_to_recipe_id is null then
    raise exception 'to_batch_id and to_recipe_id are required' using errcode = '22023';
  end if;

  select * into v_lot from public.cold_storage_inventory where id = p_lot_id for update;
  if not found then
    raise exception 'cold storage lot % not found', p_lot_id using errcode = 'P0002';
  end if;

  if v_lot.batch_id = p_to_batch_id and v_lot.recipe_id is not distinct from p_to_recipe_id then
    raise exception 'a conversion must move the stock to a different beer' using errcode = '22023';
  end if;

  if v_lot.quantity_on_hand < p_units - c_dust then
    raise exception 'lot holds % unit(s), cannot convert %',
      v_lot.quantity_on_hand, p_units using errcode = '22023';
  end if;

  v_remaining := v_lot.quantity_on_hand - p_units;
  if v_remaining <= c_dust then
    delete from public.cold_storage_inventory where id = v_lot.id;
  else
    update public.cold_storage_inventory
       set quantity_on_hand = v_remaining, updated_at = now()
     where id = v_lot.id;
  end if;

  insert into public.cold_storage_inventory (batch_id, recipe_id, variation_id, quantity_on_hand, source_transfer_id)
  values (p_to_batch_id, p_to_recipe_id, v_lot.variation_id, p_units, p_source_transfer_id)
  on conflict (batch_id, variation_id, recipe_id) do update
    set quantity_on_hand   = public.cold_storage_inventory.quantity_on_hand + excluded.quantity_on_hand,
        source_transfer_id = coalesce(excluded.source_transfer_id, public.cold_storage_inventory.source_transfer_id),
        updated_at         = now()
  returning * into v_out;

  return v_out;
end;
$function$;

grant execute on function public.move_cold_storage_lot_to_batch(uuid, numeric, uuid, uuid, uuid) to authenticated;

notify pgrst, 'reload schema';
