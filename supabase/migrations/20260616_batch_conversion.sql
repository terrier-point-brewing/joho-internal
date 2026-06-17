-- Batch conversion: a partial transfer that spawns a new child batch under a different recipe.
-- The parent batch continues at reduced volume; the child starts fermenting independently.

-- brew_batches: record lineage
alter table public.brew_batches
  add column if not exists converted_from_batch_id uuid references brew_batches(id) on delete set null,
  add column if not exists converted_volume_bbl    numeric;

-- batch_transfers: link the transfer row to the child batch it created
alter table public.batch_transfers
  add column if not exists to_batch_id uuid references brew_batches(id) on delete set null;
