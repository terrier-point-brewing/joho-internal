-- Extend square_catalog_items with item-level static fields
alter table public.square_catalog_items
  add column if not exists description       text,
  add column if not exists product_type      text,
  add column if not exists tax_ids           text[],
  add column if not exists applicable_taxes  jsonb,   -- [{id, name, percentage, inclusion_type}]
  add column if not exists is_archived       boolean  not null default false;

-- Variation-level static data
create table if not exists public.square_catalog_variations (
  id                  uuid    primary key default gen_random_uuid(),
  square_variation_id text    not null unique,
  catalog_item_id     uuid    not null references public.square_catalog_items(id) on delete cascade,
  square_item_id      text    not null,
  variation_name      text    not null,
  sku                 text,
  upc                 text,
  price_amount        bigint,        -- cents; null = variable pricing
  price_currency      text,
  pricing_type        text,          -- FIXED_PRICING | VARIABLE_PRICING
  track_inventory     boolean,
  sellable            boolean,
  stockable           boolean,
  service_duration_ms bigint,        -- for service-type items
  synced_at           timestamptz    not null default now()
);

alter table public.square_catalog_variations enable row level security;

create policy "Authenticated users can read catalog variations"
  on public.square_catalog_variations for select
  using (auth.role() = 'authenticated');

create policy "Admins can manage catalog variations"
  on public.square_catalog_variations for all
  using (
    exists (
      select 1 from profiles p
      where p.id = auth.uid() and p.role in ('admin', 'manager')
    )
  );

-- Link recipe_square_links to the variations table
alter table public.recipe_square_links
  add column if not exists catalog_variation_id uuid
    references public.square_catalog_variations(id) on delete set null;
