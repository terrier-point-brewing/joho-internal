import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/utils/api";
import { addDays, parseISO } from "date-fns";
import type { EquipmentSlot } from "../route";

export const dynamic = "force-dynamic";

interface ScheduleEntry {
  equipment_id: string | null;
  planned_start: string;
  planned_end: string;
}

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && aEnd > bStart;
}

function findEarliestSlot(
  eqId: string,
  capacityBbl: number | null,
  durationDays: number,
  earliestStart: Date,
  entries: ScheduleEntry[],
  batchVolumeBbl: number,
): Date | null {
  if (capacityBbl != null && batchVolumeBbl > capacityBbl) return null;
  const busy = entries
    .filter((e) => e.equipment_id === eqId)
    .map((e) => ({ start: parseISO(e.planned_start), end: parseISO(e.planned_end) }));
  let candidate = new Date(earliestStart);
  for (let attempt = 0; attempt < 365; attempt++) {
    const proposedEnd = addDays(candidate, durationDays);
    const conflict = busy.find((b) => overlaps(candidate, proposedEnd, b.start, b.end));
    if (!conflict) return candidate;
    candidate = new Date(conflict.end);
  }
  return null;
}

export async function POST(req: NextRequest) {
  try { await requireRole(["brewer"]); } catch (res) { return res as Response; }


  const supabase = await createSupabaseServerClient();

  try {
    const body = await req.json();
    const { recipe_id, earliest_start, volume_bbl: requestedVolume, turns: requestedTurns } = body as {
      recipe_id: string;
      earliest_start?: string;
      volume_bbl?: number;
      turns?: number;
    };

    if (!recipe_id) return NextResponse.json({ error: "recipe_id required" }, { status: 400 });

    const [{ data: recipe }, { data: equipment }, { data: scheduleEntries }] = await Promise.all([
      supabase.from("recipes").select("*").eq("id", recipe_id).single(),
      supabase.from("equipment").select("*"),
      supabase.from("batch_schedule_entries").select("equipment_id, planned_start, planned_end"),
    ]);

    if (!recipe) return NextResponse.json({ error: "Recipe not found" }, { status: 404 });

    const daysBrewhouse = recipe.days_brewhouse ?? 1;
    const daysFermenter = recipe.days_fermenter ?? 14;
    const daysBrite = recipe.days_brite ?? 7;
    const yieldBbl = recipe.expected_yield_bbl ?? 10;
    const turns = requestedTurns ?? 1;
    const volumeBbl = requestedVolume ?? yieldBbl * turns;

    const today = new Date();
    const startDate = earliest_start ? parseISO(earliest_start) : today;

    const brewhouses = (equipment ?? []).filter((e) => e.type === "brewhouse");
    const fermenters = (equipment ?? []).filter((e) => e.type === "fermenter");
    const brites = (equipment ?? []).filter((e) => e.type === "brite");
    const typedEntries = (scheduleEntries ?? []) as ScheduleEntry[];

    const stages: { type: "brewhouse" | "fermenter" | "brite"; days: number; pool: typeof brewhouses }[] = [
      { type: "brewhouse", days: daysBrewhouse, pool: brewhouses },
      { type: "fermenter", days: daysFermenter, pool: fermenters },
      { type: "brite", days: daysBrite, pool: brites },
    ];

    const eqSeq: EquipmentSlot[] = [];
    let stageStart = startDate;
    let feasible = true;

    for (const stage of stages) {
      if (stage.pool.length === 0) { feasible = false; break; }

      // Brewhouse: multiple turns run sequentially on the same day — capacity is per-turn volume.
      const effectiveVolume = stage.type === "brewhouse" ? volumeBbl / turns : volumeBbl;
      const maxSingleCap = stage.pool.reduce((m, e) => Math.max(m, e.capacity_bbl ?? 0), 0);

      // Try single tank first
      let bestEq: (typeof brewhouses)[0] | null = null;
      let bestStart: Date | null = null;
      for (const eq of stage.pool) {
        const slot = findEarliestSlot(eq.id, eq.capacity_bbl ?? null, stage.days, stageStart, typedEntries, effectiveVolume);
        if (slot && (!bestStart || slot < bestStart)) { bestStart = slot; bestEq = eq; }
      }

      if (bestEq && bestStart) {
        // Brewing is a single-day event; end = start. Fermenting/conditioning span multiple days.
        const schedEnd = stage.type === "brewhouse"
          ? bestStart.toISOString().slice(0, 10)
          : addDays(bestStart, stage.days).toISOString().slice(0, 10);
        eqSeq.push({
          stage: stage.type,
          equipment_id: bestEq.id,
          equipment_name: bestEq.name,
          scheduled_start: bestStart.toISOString().slice(0, 10),
          scheduled_end: schedEnd,
          volume_bbl: volumeBbl,
        });
        stageStart = addDays(bestStart, stage.days);
      } else if (stage.type !== "brewhouse" && maxSingleCap > 0 && volumeBbl <= maxSingleCap * 2) {
        // Single tank not enough for fermenter/brite — find 2 parallel tanks
        const halfVol = volumeBbl / 2;
        const candidates = stage.pool
          .map((eq) => ({ eq, start: findEarliestSlot(eq.id, eq.capacity_bbl ?? null, stage.days, stageStart, typedEntries, halfVol) }))
          .filter((c): c is { eq: typeof brewhouses[0]; start: Date } => c.start !== null)
          .sort((a, b) => a.start.getTime() - b.start.getTime());

        if (candidates.length >= 2) {
          // Both must start on the same date — use the later of the two earliest starts
          const sharedStart = candidates[1].start;
          eqSeq.push(
            { stage: stage.type, equipment_id: candidates[0].eq.id, equipment_name: candidates[0].eq.name, scheduled_start: sharedStart.toISOString().slice(0, 10), scheduled_end: addDays(sharedStart, stage.days).toISOString().slice(0, 10), volume_bbl: halfVol },
            { stage: stage.type, equipment_id: candidates[1].eq.id, equipment_name: candidates[1].eq.name, scheduled_start: sharedStart.toISOString().slice(0, 10), scheduled_end: addDays(sharedStart, stage.days).toISOString().slice(0, 10), volume_bbl: halfVol },
          );
          stageStart = addDays(sharedStart, stage.days);
        } else {
          feasible = false; break;
        }
      } else {
        feasible = false; break;
      }
    }

    return NextResponse.json({
      feasible,
      recommended_brew_date: feasible ? (eqSeq[0]?.scheduled_start ?? today.toISOString().slice(0, 10)) : today.toISOString().slice(0, 10),
      recommended_turns: turns,
      recommended_volume_bbl: volumeBbl,
      equipment_sequence: feasible ? eqSeq : [],
      conflict_note: feasible ? null : "No available equipment combination found for the requested volume and date.",
    });
  } catch (err) {
    return apiError(err);
  }
}
