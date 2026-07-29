-- Cancel planned packaging entries whose volume was fully absorbed elsewhere.
--
-- When an unscheduled kegging/canning run happens, transfers/route.ts claws the
-- run's volume back out of the next still-open packaging entry so the batch's
-- planned volume isn't double-counted. That claw-back drove volume_bbl down to 0
-- but left the entry open (actual_start null, cancelled_at null) — a ghost with
-- no work left in it that the Floorplan's "Up Next" banner surfaced forever.
--
-- Observed on prod 2026-07-29: B-038 (status complete since July) still advertised
-- a Canning action for 2026-07-14 from entry 95f675a7, whose volume had been
-- clawed to 0 on 2026-07-22 after the real canning ran on 07-14 and 07-17.
--
-- The route now cancels these at claw-back time. This clears the ones already
-- stranded. Two disjoint cases, both strictly "nothing left to do":
--   1. zero-volume packaging ghosts, whatever the batch's status
--   2. any open packaging entry on a batch that has already completed

update public.batch_schedule_entries
   set cancelled_at        = now(),
       cancellation_reason = 'Volume fulfilled by other packaging runs',
       updated_at          = now()
 where stage in ('kegging', 'canning')
   and cancelled_at is null
   and actual_start is null
   and volume_bbl is not null
   and volume_bbl <= 0.001;

update public.batch_schedule_entries e
   set cancelled_at        = now(),
       cancellation_reason = 'Batch completed',
       updated_at          = now()
  from public.brew_batches b
 where e.batch_id = b.id
   and e.stage in ('kegging', 'canning')
   and e.cancelled_at is null
   and e.actual_start is null
   and b.status = 'complete';
