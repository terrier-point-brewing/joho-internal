-- ─── square_fungible_skus: one Square button, several packagings behind it ───
--
-- Square sells a product. Production holds a packaging. Usually those are the
-- same thing, and `recipe_square_links` maps one to one: the POST route deletes
-- any existing link on (recipe, square_variation_id) before inserting, so
-- pointing a second packaging at a Square variation MOVES the mapping instead of
-- adding to it.
--
-- That is right almost always, and wrong when two packagings are the same
-- product to a customer. Epic Hazy IPA in Argus's printed can and Epic Hazy IPA
-- in a labeled blank are one beer, one price, one button over the bar — but two
-- bills of materials, two container costs and two rows in cold storage. Merging
-- the variations would destroy the thing that makes the invoice correct; leaving
-- them split means the taproom can only ever deplete one of them.
--
-- This table is the declaration that splits the difference: sales of THIS Square
-- variation, for THIS recipe, may be filled from ANY packaging variation linked
-- to it. Nothing is merged. Each sale still books the packaging that physically
-- left, so excise, packaging materials and the export ledger stay exact — only
-- the sale trigger is shared.
--
-- Drain order is deliberately NOT stored. It is the age of the stock:
-- cold_storage_inventory.created_at ascending across every member, which is the
-- same oldest-first rule depleteColdStorageInventory already applies within a
-- single variation. A static ranking would go stale the moment new stock landed;
-- the lot dates never do.
--
-- Absence is the default and means today's behaviour exactly, including the
-- house-stock preference in selectSaleLink that keeps a taproom sale off a
-- partner's branded keg. Groups are opt-in, per SKU, and declared by a person.

create table if not exists public.square_fungible_skus (
  recipe_id           uuid not null references public.recipes(id) on delete cascade,
  square_variation_id text not null,
  created_at          timestamp with time zone not null default now(),
  primary key (recipe_id, square_variation_id)
);

comment on table public.square_fungible_skus is
  'Declares that one Square variation may be filled from any packaging variation linked to it for this recipe. Drain order is the age of the cold-storage lot, not a stored rank. Absent = one packaging per Square variation (the default).';
comment on column public.square_fungible_skus.square_variation_id is
  'Square-native variation id, matching recipe_square_links.square_variation_id. Not a FK: the catalog mirror is a cache of Square and a declaration must outlive a re-sync.';

create index if not exists idx_square_fungible_skus_square_variation
  on public.square_fungible_skus (square_variation_id);

alter table public.square_fungible_skus enable row level security;

-- Matches recipe_square_links, the table this one qualifies. The real gate is
-- CAP.catalogOperate on the route that writes it.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'square_fungible_skus'
      and policyname = 'authenticated full access'
  ) then
    create policy "authenticated full access" on public.square_fungible_skus
      for all to authenticated
      using (true)
      with check (true);
  end if;
end $$;
