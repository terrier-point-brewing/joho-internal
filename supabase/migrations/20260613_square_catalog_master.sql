-- Master Square catalog table
create table if not exists public.square_catalog_items (
  id                   uuid        primary key default gen_random_uuid(),
  square_item_id       text        not null unique,
  item_name            text        not null,
  category_id          text,
  category_name        text,
  chart_of_accounts_id uuid        references public.chart_of_accounts(id) on delete set null,
  synced_at            timestamptz not null default now()
);

alter table public.square_catalog_items enable row level security;

create policy "Authenticated users can read catalog items"
  on public.square_catalog_items for select
  using (auth.role() = 'authenticated');

create policy "Admins can manage catalog items"
  on public.square_catalog_items for all
  using (
    exists (
      select 1 from profiles p
      where p.id = auth.uid() and p.role in ('admin', 'manager')
    )
  );

-- Add catalog_item_id FK to recipe_square_links (nullable — existing rows don't have it)
alter table public.recipe_square_links
  add column if not exists catalog_item_id uuid references public.square_catalog_items(id) on delete set null;

-- Drop the separate account mappings table (CoA is now on master table)
drop table if exists public.square_account_mappings cascade;
