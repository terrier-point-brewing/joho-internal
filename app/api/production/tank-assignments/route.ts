import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
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
  try { await requireRole("brewer"); } catch (res) { return res as Response; }


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
  const { data: tank, error: tankErr } = await supabase
    .from("equipment").select("type").eq("id", tank_id).single();
  if (tankErr) return NextResponse.json({ error: tankErr.message }, { status: 500 });

  if (tank) {
    const newStatus = EQUIPMENT_TYPE_TO_STATUS[tank.type as EquipmentType];
    if (newStatus) {
      const { data: batch, error: batchErr } = await supabase
        .from("brew_batches").select("status, recipe_id, volume_bbl, turns, turns_completed").eq("id", batch_id).single();
      if (batchErr) return NextResponse.json({ error: batchErr.message }, { status: 500 });

      if (batch?.status !== newStatus) {
        const { error: statusErr } = await supabase.from("brew_batches").update({ status: newStatus }).eq("id", batch_id);
        if (statusErr) return NextResponse.json({ error: statusErr.message }, { status: 500 });
      }

      // Always write history for brewhouse assignments so every turn start is
      // recorded even when the batch status stays "brewing" (turn 2+).
      // For other equipment types only write on actual status transitions.
      const turnsCompleted = Number(batch?.turns_completed ?? 0);
      const shouldWriteHistory = batch?.status !== newStatus || tank.type === "brewhouse";
      if (shouldWriteHistory) {
        const note = tank.type === "brewhouse" && batch?.status === newStatus
          ? `Auto: brewhouse turn ${turnsCompleted + 1}`
          : `Auto: assigned to ${tank.type}`;
        const { error: histErr } = await supabase.from("batch_status_history").insert({
          batch_id,
          status: newStatus,
          note,
        });
        if (histErr) return NextResponse.json({ error: histErr.message }, { status: 500 });
      }

      // Deduct one turn's worth of ingredients when a brew turn starts.
      if (tank.type === "brewhouse" && batch?.recipe_id) {
        const turns   = Math.max(1, Number(batch.turns ?? 1));
        const turnVol = Number(batch.volume_bbl) / turns;

        const { data: recipeIngredients, error: riErr } = await supabase
          .from("recipe_ingredients")
          .select("ingredient_id, quantity_per_bbl, ingredients(cost_per_unit, unit)")
          .eq("recipe_id", batch.recipe_id);
        if (riErr) return NextResponse.json({ error: riErr.message }, { status: 500 });

        const { data: batchRow, error: batchRowErr } = await supabase
          .from("brew_batches")
          .select("batch_number, beer_name")
          .eq("id", batch_id)
          .single();
        if (batchRowErr) return NextResponse.json({ error: batchRowErr.message }, { status: 500 });

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
              unit,
            };
          });

          const { error: adjErr } = await supabase.from("stock_adjustments").insert(adjustments);
          if (adjErr) return NextResponse.json({ error: adjErr.message }, { status: 500 });

          const { error: turnsErr } = await supabase
            .from("brew_batches")
            .update({ turns_completed: Number(batch.turns_completed ?? 0) + 1 })
            .eq("id", batch_id);
          if (turnsErr) return NextResponse.json({ error: turnsErr.message }, { status: 500 });

          // Atomically decrement each ingredient via RPC (no TOCTOU race).
          for (const ri of recipeIngredients) {
            const delta = ri.quantity_per_bbl * turnVol;
            const { error: rpcErr } = await supabase.rpc("adjust_ingredient_stock", {
              p_id:    ri.ingredient_id,
              p_delta: -delta,
            });
            if (rpcErr) return NextResponse.json({ error: rpcErr.message }, { status: 500 });
          }
        }
      }
    }
  }

  return NextResponse.json(data, { status: 201 });
}
