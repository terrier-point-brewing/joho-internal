import type { SupabaseClient } from "@supabase/supabase-js";
import { computeTankVolumes, type LedgerTransfer } from "./volumeLedger";

/**
 * Conditioning planned in the same fermenter the beer is fermenting in is not
 * a move — nothing happens to the tank, so a brewer should never have to click
 * "Confirm Conditioning". The switch is recorded on the planned date instead:
 * the fermenting entry ends and the conditioning entry starts on that date,
 * exactly what the manual in-place transfer would have written.
 *
 * Moving the beer to a brite (or another fermenter) is a real transfer and is
 * untouched by this.
 */

export interface ConditioningScheduleRow {
  id: string;
  batch_id: string;
  equipment_id: string | null;
  stage: string;
  planned_start: string;
  actual_start: string | null;
  actual_end: string | null;
  cancelled_at: string | null;
  volume_bbl: number | string | null;
}

export interface InPlaceSwitch {
  fermentingId: string;
  conditioningId: string;
  switchDate: string;
}

export interface RecordedSwitch extends InPlaceSwitch {
  /** Closed fermenting entry: everything that passed through the tank. */
  fermentingVolumeBbl: number | null;
  /** Open conditioning entry: what is still in the tank. */
  conditioningVolumeBbl: number | null;
}

/** Conditioning booked on the same tank as a fermenting entry of the same batch. */
export function isInPlaceConditioning(entry: ConditioningScheduleRow, entries: ConditioningScheduleRow[]): boolean {
  if (entry.stage !== "conditioning" || entry.cancelled_at || !entry.equipment_id) return false;
  return entries.some((e) =>
    e.batch_id === entry.batch_id && e.stage === "fermenting" && !e.cancelled_at && e.equipment_id === entry.equipment_id,
  );
}

/**
 * The switches still to record. By default only those whose planned date has
 * arrived; `beerLeavingTankId` also records one early when beer is packaged
 * out of that tank before the plan said conditioning would start — it cannot
 * condition in a tank it has left, so the switch happens today.
 */
export function planInPlaceSwitches(
  entries: ConditioningScheduleRow[],
  today: string,
  beerLeavingTankId?: string,
): InPlaceSwitch[] {
  const switches: InPlaceSwitch[] = [];
  for (const f of entries) {
    if (f.stage !== "fermenting" || f.cancelled_at || !f.equipment_id || !f.actual_start || f.actual_end) continue;
    const c = entries
      .filter((e) =>
        e.batch_id === f.batch_id && e.stage === "conditioning" && !e.cancelled_at
        && !e.actual_start && e.equipment_id === f.equipment_id,
      )
      .sort((a, b) => a.planned_start.localeCompare(b.planned_start))[0];
    if (!c) continue;
    const planned = c.planned_start.slice(0, 10);
    if (planned > today && f.equipment_id !== beerLeavingTankId) continue;
    switches.push({ fermentingId: f.id, conditioningId: c.id, switchDate: planned < today ? planned : today });
  }
  return switches;
}

/**
 * Volumes come from the transfer ledger, not the fermenting entry's own
 * volume_bbl, which can be stale when the beer was drawn from before the
 * switch was recorded (B-020 kept 32.1 bbl with ~22 bbl left). The split
 * follows the house convention: a closed entry holds what passed through, an
 * open one what is still there — so the schedule graph shows no phantom loss.
 */
export async function recordInPlaceSwitches(
  supabase: SupabaseClient,
  switches: InPlaceSwitch[],
): Promise<RecordedSwitch[]> {
  const recorded: RecordedSwitch[] = [];
  for (const s of switches) {
    const { data: ferm, error: fermErr } = await supabase
      .from("batch_schedule_entries")
      .select("batch_id, equipment_id")
      .eq("id", s.fermentingId)
      .single();
    if (fermErr) throw new Error(fermErr.message);
    const { batch_id: batchId, equipment_id: tankId } = ferm as { batch_id: string; equipment_id: string };

    const [{ data: batch }, { data: ledger, error: ledgerErr }] = await Promise.all([
      supabase.from("brew_batches").select("volume_bbl").eq("id", batchId).single(),
      supabase
        .from("batch_transfers")
        .select("batch_id, from_tank_id, to_tank_id, to_batch_id, volume_bbl, shrinkage_bbl, transferred_at")
        .or(`batch_id.eq.${batchId},to_batch_id.eq.${batchId}`),
    ]);
    if (ledgerErr) throw new Error(ledgerErr.message);
    const rows = (ledger ?? []) as LedgerTransfer[];
    let fermentingVolumeBbl: number | null = null;
    let conditioningVolumeBbl: number | null = null;
    if (rows.length > 0) {
      const remaining = computeTankVolumes(batchId, Number(batch?.volume_bbl ?? 0), rows)[tankId] ?? 0;
      const departed = rows
        .filter((t) => t.batch_id === batchId && t.from_tank_id === tankId && t.to_tank_id !== tankId)
        .reduce((sum, t) => sum + Number(t.volume_bbl) + Number(t.shrinkage_bbl ?? 0), 0);
      fermentingVolumeBbl = Math.round((remaining + departed) * 1000) / 1000;
      conditioningVolumeBbl = Math.round(remaining * 1000) / 1000;
    }

    // Guarded on the entries still being open/unstarted so two concurrent
    // readers can't stamp the same switch twice.
    const { data: closed, error: closeErr } = await supabase
      .from("batch_schedule_entries")
      .update({
        actual_end: s.switchDate,
        downstream_entry_id: s.conditioningId,
        ...(fermentingVolumeBbl != null ? { volume_bbl: fermentingVolumeBbl } : {}),
      })
      .eq("id", s.fermentingId)
      .is("actual_end", null)
      .select("id");
    if (closeErr) throw new Error(closeErr.message);
    if (!closed?.length) continue;
    const { error: startErr } = await supabase
      .from("batch_schedule_entries")
      .update({
        actual_start: s.switchDate,
        ...(conditioningVolumeBbl != null ? { volume_bbl: conditioningVolumeBbl } : {}),
      })
      .eq("id", s.conditioningId)
      .is("actual_start", null);
    if (startErr) throw new Error(startErr.message);
    recorded.push({ ...s, fermentingVolumeBbl, conditioningVolumeBbl });
  }
  return recorded;
}

const SELECT = "id, batch_id, equipment_id, stage, planned_start, actual_start, actual_end, cancelled_at, volume_bbl";

/** Record the switch for one batch's tank as beer leaves it (packaging, conversion). */
export async function recordInPlaceSwitchOnDeparture(
  supabase: SupabaseClient,
  batchId: string,
  tankId: string,
  today: string,
): Promise<void> {
  const { data, error } = await supabase
    .from("batch_schedule_entries")
    .select(SELECT)
    .eq("batch_id", batchId)
    .eq("equipment_id", tankId)
    .in("stage", ["fermenting", "conditioning"])
    .is("cancelled_at", null);
  if (error) throw new Error(error.message);
  const switches = planInPlaceSwitches((data ?? []) as ConditioningScheduleRow[], today, tankId);
  await recordInPlaceSwitches(supabase, switches);
}
