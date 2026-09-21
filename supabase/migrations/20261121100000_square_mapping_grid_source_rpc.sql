-- One round trip for the Square Item Mappings grid.
--
-- fetchMappingGrid (lib/production/mappingGridData.ts) read seven tables with
-- seven or eight separate PostgREST calls per load. Postgres answers each in a
-- couple of milliseconds, but every call also pays the API layer's latency, and
-- when that layer stalls under a burst the page waits for the slowest of eight —
-- a grid load measured 4–10s against 0.3s for a single-call sibling route.
--
-- This returns the same raw rows, in the same shapes PostgREST embedded them, as
-- one jsonb document. All shaping and suggestion logic stays in TypeScript.
--
-- SECURITY INVOKER on purpose: the caller's RLS still decides what is visible,
-- exactly as it did for the seven separate reads. Apply BEFORE the code deploys.

create or replace function public.square_mapping_grid_source()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'rpv', coalesce((
      select jsonb_agg(jsonb_build_object(
        'recipe_id', rpv.recipe_id,
        'variation_id', rpv.variation_id,
        'packaging_variations', jsonb_build_object(
          'id', pv.id, 'name', pv.name, 'format', pv.format,
          'is_active', pv.is_active, 'partner_id', pv.partner_id,
          'packaging_items', case when pi.id is null then null else jsonb_build_object(
            'id', pi.id, 'name', pi.name, 'type', pi.type, 'volume_fl_oz', pi.volume_fl_oz) end,
          'contract_brewing_partners', case when cbp.id is null then null else jsonb_build_object(
            'company_name', cbp.company_name) end
        )))
      from recipe_packaging_variations rpv
      join packaging_variations pv on pv.id = rpv.variation_id
      left join packaging_items pi on pi.id = pv.container_id
      left join contract_brewing_partners cbp on cbp.id = pv.partner_id
    ), '[]'::jsonb),

    'links', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', l.id, 'recipe_id', l.recipe_id, 'packaging', l.packaging,
        'variation_id', l.variation_id, 'catalog_variation_id', l.catalog_variation_id,
        'square_variation_id', l.square_variation_id,
        'variation_name', l.variation_name, 'item_name', l.item_name
      ) order by l.created_at)
      from recipe_square_links l
    ), '[]'::jsonb),

    'sq_vars', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', v.id, 'square_variation_id', v.square_variation_id,
        'variation_name', v.variation_name,
        'volume_fl_oz_per_unit', v.volume_fl_oz_per_unit,
        'synced_at', v.synced_at,
        'square_catalog_items', case when i.id is null then null else jsonb_build_object(
          'square_item_id', i.square_item_id, 'item_name', i.item_name,
          'category_name', i.category_name) end
      ))
      from square_catalog_variations v
      left join square_catalog_items i on i.id = v.catalog_item_id
    ), '[]'::jsonb),

    'recipes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id, 'beer_name', r.beer_name,
        'contract_brewing_partners', case when cbp.id is null then null else jsonb_build_object(
          'company_name', cbp.company_name) end
      ) order by r.beer_name)
      from recipes r
      left join contract_brewing_partners cbp on cbp.id = r.partner_id
    ), '[]'::jsonb),

    -- Generic keg variations (no partner) are not recipe-scoped.
    'generic_kegs', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', pv.id, 'name', pv.name, 'format', pv.format, 'is_active', pv.is_active,
        'packaging_items', case when pi.id is null then null else jsonb_build_object(
          'id', pi.id, 'name', pi.name, 'type', pi.type, 'volume_fl_oz', pi.volume_fl_oz) end
      ))
      from packaging_variations pv
      left join packaging_items pi on pi.id = pv.container_id
      where pv.partner_id is null and pv.is_active
    ), '[]'::jsonb),

    'ignores', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', ig.id, 'recipe_id', ig.recipe_id,
        'packaging', ig.packaging, 'variation_id', ig.variation_id))
      from recipe_square_link_ignores ig
    ), '[]'::jsonb),

    'fungible', coalesce((
      select jsonb_agg(jsonb_build_object(
        'recipe_id', f.recipe_id, 'square_variation_id', f.square_variation_id))
      from square_fungible_skus f
    ), '[]'::jsonb),

    -- Cold-storage lots for the packagings that share a declared button only —
    -- the same scoping the two-step read used.
    'lots', coalesce((
      select jsonb_agg(jsonb_build_object(
        'variation_id', c.variation_id,
        'quantity_on_hand', c.quantity_on_hand,
        'created_at', c.created_at))
      from cold_storage_inventory c
      where c.variation_id in (
        select l.variation_id
        from recipe_square_links l
        join square_fungible_skus f
          on f.recipe_id = l.recipe_id and f.square_variation_id = l.square_variation_id
        where l.variation_id is not null
      )
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.square_mapping_grid_source() from public, anon;
grant execute on function public.square_mapping_grid_source() to authenticated, service_role;
