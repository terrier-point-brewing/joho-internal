-- Castle Ruins Brown Ale can recount (counted 2026-09-28, recorded 2026-09-29).
--
-- One-off DATA migration (no schema changes), owner-directed.
--
-- Counted 41 cans, seated by the house rule (fill cases of 24, then 4-packs,
-- remainder loose): 1 case + 4 four-packs + 1 loose = 41. All against B-028,
-- the only Brown Ale lot holding cans. Before: 1 loose can only.
--
-- Under-count seated as on-hand only — no synthetic canning transfer, so batch
-- produced-volume is not inflated. Same method as the 2026-08-31 count.
--
-- ⚠️  Guarded: aborts if the B-028 can lines have moved off what was read on
--     2026-09-29, so a re-run after later activity fails loudly.
--
-- Square is not written from here; the next inventory push carries it.

begin;

do $$
declare
  b uuid := (select id from brew_batches where batch_number = 'B-028');
  r uuid := (select id from recipes where trim(beer_name) = 'Carolina Brown Ale');
  cans numeric;
begin
  select coalesce(sum(csi.quantity_on_hand), 0) into cans
    from cold_storage_inventory csi
    join packaging_variations pv on pv.id = csi.variation_id
   where csi.batch_id = b and csi.recipe_id = r
     and pv.name like 'CBC Castle Ruins Brown Ale - 16oz Labeled Can%';
  -- only the single loose can was on the books
  if cans <> 1 then
    raise exception 'B-028 Brown Ale can lines hold % units, expected 1 — re-read before applying', cans;
  end if;
end $$;

with tgt(variation_name, qty) as (values
  ('CBC Castle Ruins Brown Ale - 16oz Labeled Can Case', 1),
  ('CBC Castle Ruins Brown Ale - 16oz Labeled Can 4-Pack', 4),
  ('CBC Castle Ruins Brown Ale - 16oz Labeled Can', 1)
),
res as (
  select b.id as batch_id, r.id as recipe_id, pv.id as variation_id, t.qty::numeric as qty
  from tgt t
  join brew_batches b on b.batch_number = 'B-028'
  join recipes r on trim(r.beer_name) = 'Carolina Brown Ale'
  join packaging_variations pv on pv.name = t.variation_name
),
upd as (
  update public.cold_storage_inventory csi
     set quantity_on_hand = res.qty
    from res
   where csi.batch_id = res.batch_id
     and csi.variation_id = res.variation_id
     and csi.recipe_id is not distinct from res.recipe_id
  returning csi.batch_id, csi.variation_id, csi.recipe_id
)
insert into public.cold_storage_inventory (batch_id, recipe_id, variation_id, quantity_on_hand)
select res.batch_id, res.recipe_id, res.variation_id, res.qty
from res
where not exists (
  select 1 from upd u
  where u.batch_id = res.batch_id
    and u.variation_id = res.variation_id
    and u.recipe_id is not distinct from res.recipe_id
);

commit;
