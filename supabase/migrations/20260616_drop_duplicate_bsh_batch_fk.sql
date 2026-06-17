-- Remove duplicate FK on batch_status_history.batch_id → brew_batches.id
-- fk_bsh_batch is identical to batch_status_history_batch_id_fkey; the duplicate
-- caused PostgREST to refuse embedding with "more than one relationship found".
alter table public.batch_status_history drop constraint if exists fk_bsh_batch;
