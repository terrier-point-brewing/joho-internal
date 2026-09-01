-- apply_cold_storage_transform still upserted ON CONFLICT (batch_id, variation_id),
-- but 20261106090000 replaced the lot's unique key with
-- (batch_id, variation_id, recipe_id) NULLS NOT DISTINCT. Postgres rejects an
-- ON CONFLICT clause with no matching index (42P10), so every transform — and
-- the phantom-sale "Break down & resolve" flow that calls it — failed outright.
-- Align the conflict target with the recipe-aware index.

create or replace function public.apply_cold_storage_transform(
  p_lot_id uuid,
  p_to_variation_id uuid,
  p_from_units numeric,
  p_to_units numeric,
  p_note text default null,
  p_source_ref text default null
)
returns cold_storage_transforms
language plpgsql
set search_path to 'public'
as $function$
declare
  v_lot      public.cold_storage_inventory;
  v_from_vol numeric;
  v_to_vol   numeric;
  v_remaining numeric;
  v_result   public.cold_storage_transforms;
  c_dust constant numeric := 0.0001;
begin
  if p_from_units is null or p_from_units <= 0 then
    raise exception 'from_units must be positive' using errcode = '22023';
  end if;
  if p_to_units is null or p_to_units <= 0 then
    raise exception 'to_units must be positive' using errcode = '22023';
  end if;
  if p_to_variation_id is null then
    raise exception 'to_variation_id is required' using errcode = '22023';
  end if;

  select * into v_lot from public.cold_storage_inventory where id = p_lot_id for update;
  if not found then
    raise exception 'cold storage lot % not found', p_lot_id using errcode = 'P0002';
  end if;

  if v_lot.variation_id = p_to_variation_id then
    raise exception 'a transform must change packaging variation' using errcode = '22023';
  end if;

  if v_lot.quantity_on_hand < p_from_units - c_dust then
    raise exception 'lot holds % unit(s), cannot transform %',
      v_lot.quantity_on_hand, p_from_units using errcode = '22023';
  end if;

  select total_volume_fl_oz into v_from_vol
    from public.packaging_variations where id = v_lot.variation_id;
  select total_volume_fl_oz into v_to_vol
    from public.packaging_variations where id = p_to_variation_id;
  if v_from_vol is null then
    raise exception 'source variation % has no volume', v_lot.variation_id using errcode = '22023';
  end if;
  if v_to_vol is null then
    raise exception 'target variation % not found or has no volume', p_to_variation_id using errcode = '22023';
  end if;

  v_remaining := v_lot.quantity_on_hand - p_from_units;
  if v_remaining <= c_dust then
    delete from public.cold_storage_inventory where id = v_lot.id;
  else
    update public.cold_storage_inventory
       set quantity_on_hand = v_remaining, updated_at = now()
     where id = v_lot.id;
  end if;

  insert into public.cold_storage_inventory (batch_id, recipe_id, variation_id, quantity_on_hand)
  values (v_lot.batch_id, v_lot.recipe_id, p_to_variation_id, p_to_units)
  on conflict (batch_id, variation_id, recipe_id) do update
    set quantity_on_hand = public.cold_storage_inventory.quantity_on_hand + excluded.quantity_on_hand,
        updated_at       = now();

  insert into public.cold_storage_transforms (
    batch_id, recipe_id, from_variation_id, to_variation_id,
    from_units, to_units, from_volume_fl_oz, to_volume_fl_oz,
    note, source_ref, created_by
  ) values (
    v_lot.batch_id, v_lot.recipe_id, v_lot.variation_id, p_to_variation_id,
    p_from_units, p_to_units, v_from_vol, v_to_vol,
    nullif(btrim(coalesce(p_note, '')), ''), p_source_ref, auth.uid()
  ) returning * into v_result;

  return v_result;
end;
$function$;
