import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Deduct volume that will never be packaged under this batch from its still-
 * open (unstarted) kegging/canning schedule entries — oldest first, kegging
 * before canning — cancelling any entry clawed all the way to zero so it stops
 * advertising work in the Floorplan's "Up Next" banner.
 *
 * Two callers, one meaning:
 *  - an UNSCHEDULED packaging run (reconcileSchedule): the beer left in
 *    containers outside the plan, so the plan owes that much less;
 *  - a TANK CONVERSION (finalizeConversion): the beer left as another batch,
 *    so the source's planned packaging was oversized by exactly that volume.
 *    Before this, a converted-away batch kept full-size kegging ghosts forever.
 *
 * Walks EVERY open entry per stage rather than only the first — a batch with
 * two planned kegging runs claws both before touching canning. Returns the
 * volume it could not claw (nothing left to deduct from); the caller decides
 * whether that is noise or a flag.
 */
export async function clawBackPlannedPackaging(
  supabase: SupabaseClient,
  batchId: string,
  volumeBbl: number,
  cancellationReason: string,
): Promise<number> {
  let remaining = Number(volumeBbl);
  if (!(remaining > 0)) return 0;

  for (const stage of ["kegging", "canning"] as const) {
    if (remaining <= 0) break;
    const { data: openEntries } = await supabase
      .from("batch_schedule_entries")
      .select("id, volume_bbl")
      .eq("batch_id", batchId)
      .eq("stage", stage)
      .is("cancelled_at", null)
      .is("actual_start", null)
      .order("planned_start", { ascending: true });

    for (const openEntry of openEntries ?? []) {
      if (remaining <= 0) break;
      if (openEntry.volume_bbl == null) continue;
      const newVol = Math.max(0, Number(openEntry.volume_bbl) - remaining);
      const deducted = Number(openEntry.volume_bbl) - newVol;
      // An entry clawed to zero has no volume left to package, so it is not a
      // pending action any more (see 20260831_cancel_fulfilled_packaging_ghosts).
      const exhausted = newVol <= 0.001;
      await supabase
        .from("batch_schedule_entries")
        .update({
          volume_bbl: newVol,
          ...(exhausted ? {
            cancelled_at: new Date().toISOString(),
            cancellation_reason: cancellationReason,
          } : {}),
        })
        .eq("id", openEntry.id);
      remaining -= deducted;
    }
  }

  return Math.max(0, remaining);
}
