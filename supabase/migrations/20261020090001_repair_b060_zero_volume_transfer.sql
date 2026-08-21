-- B-060 hit the same 0 BBL transfer as B-059, two and a half hours later:
-- dragged B-2 -> fermenter 21 on the Floorplan at 15:56 with an empty volume
-- box, leaving the batch assigned to both tanks. Same repair, same reasoning as
-- 20261020090000. Every statement is keyed to specific rows, so a re-run is a
-- no-op.
begin;

-- The move was the whole tank: B-2 is a 20 BBL brewhouse and B-060 is a single
-- 20 BBL turn. No shrinkage was reported.
update public.batch_transfers
   set volume_bbl = 20
 where id = '9f5692e7-959b-4fb2-be3c-91187e90afd3'
   and volume_bbl = 0;

-- Retroactive origin row for the brew turn, matching what the assignment route
-- now writes going forward.
insert into public.batch_transfers
       (batch_id, from_tank_id, to_tank_id, volume_bbl, shrinkage_bbl, transfer_type, notes, transferred_at)
select 'c88459d6-ac97-489c-bdce-fb9299114435',
       null,
       '95ddac06-0976-42c8-9ffd-e0c004e306b8',   -- B-2
       20,
       0,
       'brewing',
       'Turn 1 — brew turn start (backfilled: predates the ledger origin row)',
       '2026-08-21 15:56:01.185578+00'
 where not exists (
   select 1 from public.batch_transfers
    where batch_id = 'c88459d6-ac97-489c-bdce-fb9299114435'
      and transfer_type = 'brewing'
 );

-- Release the assignment the phantom partial-transfer re-opened.
update public.batch_tank_assignments
   set released_at = '2026-08-21 15:56:10.339788+00',
       notes       = coalesce(notes || ' | ', '') || 'Released: re-opened in error by a 0 BBL transfer'
 where id = 'e86a3a68-98df-4c71-b1f0-37e1a81075db'
   and released_at is null;

-- Close the brewhouse schedule entry the departure block never reached.
update public.batch_schedule_entries
   set actual_end = '2026-08-21'
 where id = 'bc748ee8-6588-4759-97b5-987ce4fee6f2'
   and actual_end is null;

commit;
