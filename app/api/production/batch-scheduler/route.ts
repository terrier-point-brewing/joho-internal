import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/utils/api";
import { addDays, parseISO } from "date-fns";
import { loadIntakeDemand } from "@/lib/production/intakeDemand.server";
import { occupiedTanksAsEntries, planTankSlots, type PlannedSlot, type SlotBusyEntry, type SlotTank } from "@/lib/production/tankSlots";
import { batchFillBbl } from "@/lib/production/batchVolume";

export const dynamic = "force-dynamic";

/** Most turns one batch can take. */
const MAX_TURNS = 4;

export type EquipmentSlot = PlannedSlot;

export interface SchedulerRecommendation {
  recipe_id: string;
  style: string;
  stockout_date: string;
  demand_bbl: number;
  recommended_turns: number;
  recommended_volume_bbl: number;
  recommended_brew_date: string;
  equipment_sequence: EquipmentSlot[];
  /** Why this beer needs a batch but could not be planned. The row still shows. */
  blocked_reason: string | null;
}

export interface SchedulerResponse {
  recommendations: SchedulerRecommendation[];
  warnings: string[];
}

export async function GET() {
  const supabase = await createSupabaseServerClient();

  try {
    const [demand, tanksRes, entriesRes, assignmentsRes] = await Promise.all([
      loadIntakeDemand(supabase),
      supabase.from("equipment").select("id, name, type, capacity_bbl"),
      supabase.from("batch_schedule_entries").select("equipment_id, planned_start, planned_end, actual_start, actual_end, cancelled_at"),
      supabase.from("batch_tank_assignments").select("tank_id, assigned_at").is("released_at", null),
    ]);
    const readErr = tanksRes.error ?? entriesRes.error ?? assignmentsRes.error;
    if (readErr) throw new Error(readErr.message);

    const today = new Date();
    const tanks = (tanksRes.data ?? []) as SlotTank[];
    const scheduled = (entriesRes.data ?? []) as SlotBusyEntry[];
    const entries = [...scheduled, ...occupiedTanksAsEntries(assignmentsRes.data ?? [], scheduled, today)];
    const recipeById = new Map(demand.recipes.map((r) => [r.id, r]));

    const recommendations: SchedulerRecommendation[] = [];

    for (const row of demand.rows) {
      if (row.is_retired || !row.action_date || row.status === "green") continue;
      const recipe = recipeById.get(row.recipe_id);
      if (!recipe) continue;

      // What a NEW batch has to cover: the shortfall still open one lead time
      // from now (beer already in tanks is inside the projection), or the
      // commitments no batch covers yet — whichever is larger.
      const demandBbl = Math.round(Math.max(row.short_bbl, row.uncovered_bbl) * 100) / 100;

      const base = { recipe_id: row.recipe_id, style: row.style, stockout_date: row.action_date, demand_bbl: demandBbl };
      const blocked = (reason: string, turns = 1, volume = 0): SchedulerRecommendation => ({
        ...base, recommended_turns: turns, recommended_volume_bbl: volume,
        recommended_brew_date: today.toISOString().slice(0, 10), equipment_sequence: [], blocked_reason: reason,
      });

      if (!recipe.expected_yield_bbl) {
        recommendations.push(blocked("This recipe has no expected yield. Set it in Recipes so the batch can be sized."));
        continue;
      }
      if (row.lead_time_days === 0) {
        recommendations.push(blocked("This recipe has no brewhouse, fermenter or brite days. Set them in Recipes."));
        continue;
      }

      const turns = Math.min(Math.max(Math.ceil(demandBbl / recipe.expected_yield_bbl), 1), MAX_TURNS);
      // Turns are sized off expected yield (post-loss demand); the batch itself is
      // booked at brewhouse fill, like every other batch.
      const volume = batchFillBbl(turns);

      // Work backwards from the stockout; never recommend a brew date in the past.
      const ideal = addDays(parseISO(row.action_date), -row.lead_time_days);
      const plan = planTankSlots({
        tanks, entries, volumeBbl: volume, turns,
        startDate: ideal < today ? today : ideal,
        days: {
          brewhouse: recipe.days_brewhouse ?? 1,
          fermenter: recipe.days_fermenter ?? 14,
          brite: recipe.days_brite ?? 7,
        },
      });

      if (!plan.feasible) {
        recommendations.push(blocked(plan.reason ?? "No tank plan was found.", turns, volume));
        continue;
      }
      recommendations.push({
        ...base,
        recommended_turns: turns,
        recommended_volume_bbl: volume,
        recommended_brew_date: plan.sequence[0].scheduled_start,
        equipment_sequence: plan.sequence,
        blocked_reason: null,
      });
    }

    // Most urgent first.
    recommendations.sort((a, b) => a.stockout_date.localeCompare(b.stockout_date));

    return NextResponse.json({ recommendations, warnings: demand.warnings } satisfies SchedulerResponse);
  } catch (err) {
    return apiError(err);
  }
}
