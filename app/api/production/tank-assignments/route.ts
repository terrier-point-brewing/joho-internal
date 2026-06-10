import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { EQUIPMENT_TYPE_TO_STATUS, EquipmentType } from "@/app/production/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from("batch_tank_assignments")
    .select("*, brew_batches(id, beer_name, batch_number, status, volume_bbl)")
    .is("released_at", null)
    .order("assigned_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  const supabase = await createSupabaseServerClient();

  const body = await req.json();
  const { batch_id, tank_id, notes } = body;

  // Occupancy is enforced atomically by the partial unique index
  // one_active_assignment_per_tank; a double-book surfaces as a 23505 conflict.
  const { data, error } = await supabase
    .from("batch_tank_assignments")
    .insert({ batch_id, tank_id, notes: notes || null })
    .select("*, brew_batches(id, beer_name, batch_number, status, volume_bbl)")
    .single();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: "Tank is already occupied" }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Auto-update batch status based on tank type; deduct per-turn ingredients for brewhouse.
  const { data: tank } = await supabase
    .from("equipment").select("type").eq("id", tank_id).single();

  if (tank) {
    const newStatus = EQUIPMENT_TYPE_TO_STATUS[tank.type as EquipmentType];
    if (newStatus) {
      const { data: batch } = await supabase
        .from("brew_batches").select("status, recipe_id, volume_bbl, turns, turns_completed").eq("id", batch_id).single();

      if (batch?.status !== newStatus) {
        await supabase.from("brew_batches").update({ status: newStatus }).eq("id", batch_id);
        await supabase.from("batch_status_history").insert({
          batch_id,
          status: newStatus,
          note: `Auto: assigned to ${tank.type}`,
        });
      }

      // Deduct one turn's worth of ingredients when a brew turn starts.
      if (tank.type === "brewhouse" && batch?.recipe_id) {
        const turns   = Math.max(1, Number(batch.turns ?? 1));
        const turnVol = Number(batch.volume_bbl) / turns;

        const { data: recipeIngredients } = await supabase
          .from("recipe_ingredients")
          .select("ingredient_id, quantity_per_bbl, ingredients(cost_per_unit, unit)")
          .eq("recipe_id", batch.recipe_id);

        const { data: batchRow } = await supabase
          .from("brew_batches")
          .select("batch_number, beer_name")
          .eq("id", batch_id)
          .single();

        if (recipeIngredients?.length) {
          type IngMeta = { cost_per_unit: number | null; unit: string | null };
          const adjustments = recipeIngredients.map((ri) => {
            const qty     = ri.quantity_per_bbl * turnVol;
            const ingMeta = (ri.ingredients as unknown as IngMeta | null);
            const costPU  = ingMeta?.cost_per_unit ?? null;
            const unit    = ingMeta?.unit ?? null;
            return {
              ingredient_id:      ri.ingredient_id,
              quantity:           -qty,
              type:               "batch_use" as const,
              note:               `Turn start — ${batchRow?.batch_number ?? batch_id}: ${batchRow?.beer_name ?? ""}`,
              batch_id,
              cost_per_unit:      costPU,
              total_value_change: costPU != null ? -qty * costPU : null,
              unit,                          // snapshot ingredient unit at write time
            };
          });

          await supabase.from("stock_adjustments").insert(adjustments);

          // Increment turns_completed counter on the batch.
          await supabase
            .from("brew_batches")
            .update({ turns_completed: Number(batch.turns_completed ?? 0) + 1 })
            .eq("id", batch_id);

          // Apply stock deltas one by one (no batch-update RPC available).
          for (const ri of recipeIngredients) {
            const delta = ri.quantity_per_bbl * turnVol;
            const { data: ing } = await supabase
              .from("ingredients")
              .select("stock_quantity")
              .eq("id", ri.ingredient_id)
              .single();
            if (ing) {
              await supabase
                .from("ingredients")
                .update({ stock_quantity: Number(ing.stock_quantity) - delta })
                .eq("id", ri.ingredient_id);
            }
          }
        }
      }
    }
  }

  return NextResponse.json(data, { status: 201 });
}
