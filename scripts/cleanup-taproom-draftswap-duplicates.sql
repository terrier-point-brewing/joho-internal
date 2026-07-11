-- ============================================================================
-- One-time cleanup: duplicate taproom draft-swap rows from the webhook race
-- ============================================================================
--
-- REVIEW, then run ONCE against prod, after a backup. Not a migration — kept out
-- of supabase/migrations/ on purpose so it never auto-applies.
--
-- Cause (fixed by supabase/migrations/20260726_taproom_sync_lock.sql): the Square
-- webhook fired the full taproom-consumption sync on every order.* event, so one
-- Draft Restock's event burst ran ~6 syncs concurrently. Each read "0 already
-- recorded" for the swap's source_ref and wrote its own export_transactions row,
-- and each row also drained cold_storage_inventory. Net effect: N rows + N kegs
-- drained for a physical 1-keg swap.
--
-- Verified ground state 2026-07-10 (each row quantity=1 of the 1/6-keg variation
-- 4ddbce98, volume 0.1666 bbl):
--
--   ref sqtransfer:1wI786…:c55c6a10   Epic Hazy IPA   B-029 (8ad94d74)
--       5 rows  → keep 1, delete 4
--       cold_storage_inventory eef32077 (batch 8ad94d74, var 4ddbce98): 4 → 8 (+4)
--
--   ref sqtransfer:nN0Am…:c0c09e28    Carolina Pale Ale  B-044 (e59b30ee)
--       6 rows  → keep 1, delete 5
--       cold_storage_inventory 429fdf01 (batch e59b30ee, var 4ddbce98): 3 → 8 (+5)
--
-- The kept row (earliest by created_at) is the one legitimate swap consumption.
-- Deleting export_transactions cascades to export_transaction_taxes (FK ON DELETE
-- CASCADE); taproom rows carry $0 excise so there is nothing meaningful to lose.
--
-- Idempotent: re-running is a no-op — only 1 row per ref remains, so the DELETE
-- matches nothing and the cold-storage top-up adds 0.
--
-- NOT handled automatically (review by hand):
--   * Batch B-044 is currently status='complete'. Confirm that is independently
--     correct now that 5 kegs are restored to its cold storage; this script does
--     NOT change batch status.
--   * draft_swap_shrinkage upserts on source_ref, so there is exactly one row per
--     swap already — no shrinkage cleanup needed.
--   * The Square draft SKU recount (absolute set to 660 fl oz) is idempotent —
--     no Square-side cleanup needed.

begin;

-- ── Ref 1: Epic Hazy IPA B-029 ──────────────────────────────────────────────
with keep as (
  select id
  from public.export_transactions
  where source_ref = 'sqtransfer:1wI786QdTgKi3GAumLbzDrJyWANZY:c55c6a10-a2d0-4ccc-a28f-ff52173bbac8'
  order by created_at asc
  limit 1
),
del as (
  delete from public.export_transactions
  where source_ref = 'sqtransfer:1wI786QdTgKi3GAumLbzDrJyWANZY:c55c6a10-a2d0-4ccc-a28f-ff52173bbac8'
    and id not in (select id from keep)
  returning quantity
)
update public.cold_storage_inventory
set quantity_on_hand = quantity_on_hand + (select coalesce(sum(quantity), 0) from del),
    updated_at = now()
where id = 'eef32077-8466-442b-88d7-22e46b17356f';

-- ── Ref 2: Carolina Pale Ale B-044 ──────────────────────────────────────────
with keep as (
  select id
  from public.export_transactions
  where source_ref = 'sqtransfer:nN0AmHwzef81ULEVt8CpNXb7QSdZY:c0c09e28-e820-4cd8-95eb-bc15f60f6197'
  order by created_at asc
  limit 1
),
del as (
  delete from public.export_transactions
  where source_ref = 'sqtransfer:nN0AmHwzef81ULEVt8CpNXb7QSdZY:c0c09e28-e820-4cd8-95eb-bc15f60f6197'
    and id not in (select id from keep)
  returning quantity
)
update public.cold_storage_inventory
set quantity_on_hand = quantity_on_hand + (select coalesce(sum(quantity), 0) from del),
    updated_at = now()
where id = '429fdf01-8b0d-4c5b-972c-da03fd5ffb3d';

-- ── Verify BEFORE commit (expect 1 row per ref; cold storage 8 and 8) ────────
-- select source_ref, count(*) as rows, sum(quantity) as qty
-- from public.export_transactions
-- where source_ref in (
--   'sqtransfer:1wI786QdTgKi3GAumLbzDrJyWANZY:c55c6a10-a2d0-4ccc-a28f-ff52173bbac8',
--   'sqtransfer:nN0AmHwzef81ULEVt8CpNXb7QSdZY:c0c09e28-e820-4cd8-95eb-bc15f60f6197'
-- ) group by source_ref;
--
-- select id, batch_id, quantity_on_hand
-- from public.cold_storage_inventory
-- where id in ('eef32077-8466-442b-88d7-22e46b17356f', '429fdf01-8b0d-4c5b-972c-da03fd5ffb3d');

commit;
