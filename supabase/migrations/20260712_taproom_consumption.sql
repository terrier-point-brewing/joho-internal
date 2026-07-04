-- Taproom consumption → cold storage drain.
--
-- Taproom pours (keg sales, can sales, draft keg-swaps) are recorded as
-- `taproom`-channel export_transactions that deplete cold_storage_inventory,
-- derived from Square by the taproom-consumption sync. Two additions:
--
-- 1. export_transactions.source_ref — idempotency key for the reconciling sync.
--    Sales reconcile per (variation, day): "sqsale:<variationId>:<YYYY-MM-DD>".
--    Draft swaps reconcile per event:      "sqkegswap:<physicalCountId>".
--    NULL on every non-sync row (all existing rows). Not unique: a single unit
--    can split across cold-storage lots into multiple rows sharing the ref; the
--    sync sums recorded quantity per ref and records only the remaining delta.
--
-- 2. taproom_recipe_settings swap config — makes the draft swap inventory
--    explicit per recipe instead of inferred from container volume. A keg swap
--    depletes one `swap_variation_id`; `swap_volume_fl_oz` is the full-keg retop
--    level that also drives swap detection (660 for a 1/6, 1980 for a 1/2, …).

alter table public.export_transactions
  add column if not exists source_ref text;

create index if not exists idx_export_transactions_source_ref
  on public.export_transactions (source_ref)
  where source_ref is not null;

alter table public.taproom_recipe_settings
  add column if not exists swap_variation_id uuid
    references public.packaging_variations(id) on delete set null;

alter table public.taproom_recipe_settings
  add column if not exists swap_volume_fl_oz numeric;
