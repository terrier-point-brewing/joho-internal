-- B-059 was dragged B-1 → fermenter 14 on the Floorplan, but the transfer was
-- submitted with volume_bbl = 0 (the modal's volume box starts empty and had no
-- guard). The RPC released B-1 correctly; then the partial-transfer branch in
-- app/api/production/transfers/route.ts saw B-1 still holding its full 20 BBL,
-- concluded beer was left behind, and re-assigned B-1. The batch has shown in
-- two tanks ever since.
--
-- The code fixes ship alongside this file: a zero-volume transfer is now
-- rejected client- and server-side, and a brewhouse assignment writes its own
-- "brewing" ledger origin row instead of leaving computeTankVolumes to guess.
--
-- This repairs the one batch already damaged. Every statement is keyed to the
-- specific rows involved, so a re-run is a no-op.
begin;

-- 1. The move was the whole tank: B-1 is a 20 BBL brewhouse and B-059 is a
--    single 20 BBL turn. No shrinkage was reported.
update public.batch_transfers
   set volume_bbl = 20
 where id = '495a7d35-efcf-4a41-be46-0f35cb82fb0e'
   and volume_bbl = 0;

-- 2. Retroactive origin row for the brew turn, matching what the assignment
--    route now writes going forward. from_tank_id stays null — "Backlog" is
--    rendered from transfer_type, not from an equipment row.
insert into public.batch_transfers
       (batch_id, from_tank_id, to_tank_id, volume_bbl, shrinkage_bbl, transfer_type, notes, transferred_at)
select 'd6f41318-0b8d-425f-bc6e-952e96b2ffdc',
       null,
       'fa3e8982-663f-416b-8de2-bab0bc8b477e',   -- B-1
       20,
       0,
       'brewing',
       'Turn 1 — brew turn start (backfilled: predates the ledger origin row)',
       '2026-08-21 13:16:17.59664+00'
 where not exists (
   select 1 from public.batch_transfers
    where batch_id = 'd6f41318-0b8d-425f-bc6e-952e96b2ffdc'
      and transfer_type = 'brewing'
 );

-- 3. Release the assignment the phantom partial-transfer re-opened. B-059 is in
--    fermenter 14; B-1 is empty and available to the next brew.
update public.batch_tank_assignments
   set released_at = '2026-08-21 13:18:11.100048+00',
       notes       = coalesce(notes || ' | ', '') || 'Released: re-opened in error by a 0 BBL transfer'
 where id = 'a2b16477-d889-4a48-8929-3232703c23bb'
   and released_at is null;

-- 4. Close the brewhouse schedule entry. The departure block never fired,
--    because on paper the tank never drained.
update public.batch_schedule_entries
   set actual_end = '2026-08-21'
 where id = '938a5628-11f9-4b5d-bb84-c2208ce67890'
   and actual_end is null;

commit;
