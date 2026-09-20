import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/utils/api";
import { parseISO } from "date-fns";
import { occupiedTanksAsEntries, planTankSlots, type SlotBusyEntry, type SlotTank } from "@/lib/production/tankSlots";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try { await requirePermission(CAP.brewingOperate); } catch (res) { return res as Response; }

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

    const [recipeRes, equipmentRes, entriesRes, assignmentsRes] = await Promise.all([
      supabase.from("recipes").select("*").eq("id", recipe_id).maybeSingle(),
      supabase.from("equipment").select("id, name, type, capacity_bbl"),
      supabase.from("batch_schedule_entries").select("equipment_id, planned_start, planned_end, actual_start, actual_end, cancelled_at"),
      supabase.from("batch_tank_assignments").select("tank_id, assigned_at").is("released_at", null),
    ]);
    const readErr = recipeRes.error ?? equipmentRes.error ?? entriesRes.error ?? assignmentsRes.error;
    if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });
    const recipe = recipeRes.data;
    if (!recipe) return NextResponse.json({ error: "Recipe not found" }, { status: 404 });

    const turns = Math.max(1, requestedTurns ?? 1);
    const volumeBbl = requestedVolume ?? (recipe.expected_yield_bbl != null ? recipe.expected_yield_bbl * turns : null);
    if (!volumeBbl) {
      return NextResponse.json({ error: "This recipe has no expected yield — set it in Recipes so the batch can be sized." }, { status: 422 });
    }

    const today = new Date();
    const entries = (entriesRes.data ?? []) as SlotBusyEntry[];
    const plan = planTankSlots({
      tanks: (equipmentRes.data ?? []) as SlotTank[],
      entries: [...entries, ...occupiedTanksAsEntries(assignmentsRes.data ?? [], entries, today)],
      volumeBbl,
      turns,
      startDate: earliest_start ? parseISO(earliest_start) : today,
      days: {
        brewhouse: recipe.days_brewhouse ?? 1,
        fermenter: recipe.days_fermenter ?? 14,
        brite: recipe.days_brite ?? 7,
      },
    });

    return NextResponse.json({
      feasible: plan.feasible,
      recommended_brew_date: plan.sequence[0]?.scheduled_start ?? today.toISOString().slice(0, 10),
      recommended_turns: turns,
      recommended_volume_bbl: volumeBbl,
      equipment_sequence: plan.sequence,
      conflict_note: plan.reason,
    });
  } catch (err) {
    return apiError(err);
  }
}
