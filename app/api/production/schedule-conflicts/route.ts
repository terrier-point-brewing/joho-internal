import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { parseISO, addDays } from "date-fns";

// Equipment types where multi-batch overlap is allowed (no conflict detection)
const MULTI_BATCH_TYPES = new Set(["kegging", "canning", "cold_storage"]);

interface RawEntry {
  id: string;
  batch_id: string;
  equipment_id: string | null;
  stage: string;
  planned_start: string;
  planned_end: string;
  actual_start: string | null;
  actual_end: string | null;
  cancelled_at: string | null;
  brew_batches: { id: string; beer_name: string; batch_number: string; volume_bbl: number; recipe_id: string | null } | null;
  equipment: { id: string; name: string; type: string } | null;
}

function effectiveStart(e: RawEntry): Date {
  return parseISO(e.actual_start ?? e.planned_start);
}
function effectiveEnd(e: RawEntry): Date {
  return parseISO(e.actual_end ?? e.planned_end);
}
function overlaps(aS: Date, aE: Date, bS: Date, bE: Date) {
  return aS < bE && aE > bS;
}

/** Find earliest available slot on this equipment after earliestStart,
 *  avoiding the provided busy windows. Returns null if none found in 365 days. */
function findNextSlot(
  equipmentId: string,
  durationDays: number,
  earliestStart: Date,
  busyEntries: RawEntry[],
  excludeBatchId: string,
): { start: Date; end: Date } | null {
  const busy = busyEntries
    .filter((e) => e.equipment_id === equipmentId && e.batch_id !== excludeBatchId)
    .map((e) => ({ start: effectiveStart(e), end: effectiveEnd(e) }));

  let candidate = new Date(earliestStart);
  for (let attempt = 0; attempt < 365; attempt++) {
    const candidateEnd = addDays(candidate, durationDays);
    const conflict = busy.find((b) => overlaps(candidate, candidateEnd, b.start, b.end));
    if (!conflict) return { start: candidate, end: candidateEnd };
    candidate = new Date(conflict.end);
  }
  return null;
}

export async function GET() {
  try {
    const { data: entries, error } = await supabase
      .from("batch_schedule_entries")
      .select(`
        id, batch_id, equipment_id, stage, planned_start, planned_end,
        actual_start, actual_end, cancelled_at,
        brew_batches(id, beer_name, batch_number, volume_bbl, recipe_id),
        equipment(id, name, type)
      `)
      .is("cancelled_at", null)
      .order("planned_start", { ascending: true });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const rows = (entries ?? []) as unknown as RawEntry[];

    // Group by equipment_id, skip multi-batch-allowed types
    const byEquipment = new Map<string, RawEntry[]>();
    for (const e of rows) {
      if (!e.equipment_id) continue;
      if (MULTI_BATCH_TYPES.has(e.equipment?.type ?? "")) continue;
      const group = byEquipment.get(e.equipment_id) ?? [];
      group.push(e);
      byEquipment.set(e.equipment_id, group);
    }

    const conflicts: unknown[] = [];
    const today = new Date();

    for (const [, group] of byEquipment) {
      // Compare every pair
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const a = group[i], b = group[j];
          if (a.batch_id === b.batch_id) continue;
          // Skip if both are completed (actual_end in the past)
          if (a.actual_end && parseISO(a.actual_end) < today) continue;
          if (b.actual_end && parseISO(b.actual_end) < today) continue;

          const aS = effectiveStart(a), aE = effectiveEnd(a);
          const bS = effectiveStart(b), bE = effectiveEnd(b);
          if (!overlaps(aS, aE, bS, bE)) continue;

          // "b" is the displaced batch — suggest a new slot for it
          const bDuration = Math.max(
            Math.round((bE.getTime() - bS.getTime()) / 86400000),
            1,
          );
          // Find other equipment of the same type
          const { data: sameType } = await supabase
            .from("equipment")
            .select("id, name, type")
            .eq("type", b.equipment?.type ?? "")
            .neq("id", b.equipment_id ?? "");

          let suggestion = null;
          for (const alt of sameType ?? []) {
            const slot = findNextSlot(alt.id, bDuration, today, rows, b.batch_id);
            if (slot) {
              suggestion = { equipment_id: alt.id, equipment_name: alt.name, new_start: slot.start.toISOString(), new_end: slot.end.toISOString() };
              break;
            }
          }
          // Also try the same equipment after the conflict clears
          if (!suggestion) {
            const slot = findNextSlot(b.equipment_id!, bDuration, aE, rows, b.batch_id);
            if (slot) suggestion = { equipment_id: b.equipment_id!, equipment_name: b.equipment?.name ?? "", new_start: slot.start.toISOString(), new_end: slot.end.toISOString() };
          }

          conflicts.push({
            id: `${a.id}:${b.id}`,
            entry_a: { id: a.id, batch_id: a.batch_id, batch_number: a.brew_batches?.batch_number, beer_name: a.brew_batches?.beer_name },
            entry_b: { id: b.id, batch_id: b.batch_id, batch_number: b.brew_batches?.batch_number, beer_name: b.brew_batches?.beer_name },
            equipment: { id: a.equipment?.id, name: a.equipment?.name },
            overlap_start: (aS > bS ? aS : bS).toISOString(),
            overlap_end:   (aE < bE ? aE : bE).toISOString(),
            suggested_resolution: suggestion,
          });
        }
      }
    }

    return NextResponse.json(conflicts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
