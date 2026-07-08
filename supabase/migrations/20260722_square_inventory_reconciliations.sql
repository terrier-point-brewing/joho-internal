-- Journal of cold-storage → Square can-inventory write-backs.
--
-- Each row is one correction: the reconciler wrote `cold_storage_cans` onto a
-- family's base (loose) Square variation because it drifted from cold storage
-- (the source of truth). Drives the "Square auto-reconciled to cold storage"
-- notice on the taproom Performance > Inventory subtab. Append-only.

create table if not exists public.square_inventory_reconciliations (
  id                        uuid primary key default gen_random_uuid(),
  recipe_id                 uuid references public.recipes(id) on delete set null,
  base_square_variation_id  text not null,
  base_variation_name       text,
  cold_storage_cans         numeric not null,   -- value written to Square (whole cans)
  square_cans_before        numeric not null,   -- Square's count just before the write
  drift                     numeric not null,   -- square_cans_before - cold_storage_cans
  occurred_at               timestamptz not null default now(),
  created_at                timestamptz not null default now()
);

create index if not exists sq_inv_recon_occurred_idx
  on public.square_inventory_reconciliations (occurred_at desc);
create index if not exists sq_inv_recon_recipe_idx
  on public.square_inventory_reconciliations (recipe_id);
