-- Remove duplicate FKs on brew_batches child tables.
-- Each table had both a generated _fkey constraint and a manually named fk_* constraint,
-- both identical, causing PostgREST to refuse embedding with "more than one relationship found".
alter table public.batch_brew_activity_log  drop constraint if exists fk_bbal_batch;
alter table public.batch_tank_assignments   drop constraint if exists fk_bta_batch;
alter table public.batch_transfers          drop constraint if exists fk_bt_batch;
alter table public.batch_schedule_entries   drop constraint if exists fk_bse_batch;
alter table public.batch_exports            drop constraint if exists fk_be_batch;
alter table public.batch_allocations        drop constraint if exists fk_ba_batch;
