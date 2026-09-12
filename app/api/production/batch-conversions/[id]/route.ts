import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { reserveConversionAdditions } from "@/lib/production/conversionIngredients";
import { deriveConversionDeliveryDate, seedConversionChildSchedule } from "@/lib/production/conversionFinalizer";
import { releaseCommitments, upsertCommitments } from "@/lib/production/commitments";
import { cancelInvoice } from "@/lib/square/square-invoices";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

const BATCH_CONVERSION_SELECT = `
  id, source_batch_id, target_batch_id, source_equipment_id,
  volume_bbl, planned_date, converted_at, notes, created_at,
  target_batch:brew_batches!target_batch_id(id, beer_name, batch_number),
  source_batch:brew_batches!source_batch_id(id, beer_name, batch_number)
`.trim();

interface PlanRow {
  id: string;
  source_batch_id: string;
  target_batch_id: string;
  volume_bbl: number;
  planned_date: string | null;
  converted_at: string | null;
}

interface TargetBatch {
  id: string;
  status: string | null;
  recipe_id: string | null;
  turns: number | null;
  volume_bbl: number | null;
  converted_volume_bbl: number | null;
  converted_from_batch_id: string | null;
  square_invoice_id: string | null;
}

async function loadPlan(supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>, id: string) {
  const { data } = await supabase
    .from("batch_conversions")
    .select("id, source_batch_id, target_batch_id, volume_bbl, planned_date, converted_at")
    .eq("id", id)
    .maybeSingle();
  return data as PlanRow | null;
}

// PATCH /api/production/batch-conversions/[id]
// Edit a still-pending conversion plan: volume, planned date, notes. The
// ingredient reservation and (for a plan-born child) the child's own volume
// and dates follow the edit, so the plan never drifts from what it reserved.
export async function PATCH(req: NextRequest, { params }: RouteParams) {
  try { await requirePermission(CAP.brewingOperate); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const { id } = await params;
  const body = await req.json();

  const plan = await loadPlan(supabase, id);
  if (!plan) return NextResponse.json({ error: "Conversion plan not found" }, { status: 404 });
  if (plan.converted_at) {
    return NextResponse.json({ error: "This conversion has already been executed — its record cannot be edited." }, { status: 422 });
  }

  const updates: Record<string, unknown> = {};
  if (body.volume_bbl != null) {
    const vol = Number(body.volume_bbl);
    if (!Number.isFinite(vol) || vol <= 0) {
      return NextResponse.json({ error: "volume_bbl must be greater than zero." }, { status: 422 });
    }
    updates.volume_bbl = vol;
  }
  if (body.planned_date !== undefined) updates.planned_date = body.planned_date || null;
  if (body.notes !== undefined)        updates.notes = body.notes || null;
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "Nothing to update — pass volume_bbl, planned_date, or notes." }, { status: 422 });
  }

  const { data: updated, error } = await supabase
    .from("batch_conversions")
    .update(updates)
    .eq("id", id)
    .select(BATCH_CONVERSION_SELECT)
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const newVolume = updates.volume_bbl != null ? Number(updates.volume_bbl) : Number(plan.volume_bbl);
  const newDate   = updates.planned_date !== undefined ? (updates.planned_date as string | null) : plan.planned_date;

  // Keep a plan-born child in step with its plan. Only a PURE conversion child
  // is touched — one whose headline volume IS the plan's volume — never a
  // pre-existing batch the plan merely points at.
  const { data: targetRow } = await supabase
    .from("brew_batches")
    .select("id, status, recipe_id, volume_bbl, converted_volume_bbl, converted_from_batch_id")
    .eq("id", plan.target_batch_id)
    .maybeSingle();
  const target = targetRow as TargetBatch | null;
  const planBorn = target
    && target.converted_from_batch_id === plan.source_batch_id
    && target.status === "planning"
    && target.converted_volume_bbl != null
    && Math.abs(Number(target.volume_bbl ?? 0) - Number(target.converted_volume_bbl)) < 0.001;

  if (planBorn && target) {
    const childUpdates: Record<string, unknown> = {};
    if (updates.volume_bbl != null) {
      childUpdates.volume_bbl = newVolume;
      childUpdates.converted_volume_bbl = newVolume;
    }
    if (updates.planned_date !== undefined && newDate && target.recipe_id) {
      childUpdates.planned_brew_date = newDate;
      childUpdates.expected_delivery_date = await deriveConversionDeliveryDate(supabase, target.recipe_id, newDate);
    }
    if (Object.keys(childUpdates).length > 0) {
      await supabase.from("brew_batches").update(childUpdates).eq("id", target.id);
    }

    // Keep the seeded schedule in step with the edited plan — replaces only
    // the marker-stamped, unstarted ghosts; anything begun or hand-made stays.
    if ((updates.volume_bbl != null || updates.planned_date !== undefined) && target.recipe_id) {
      try {
        await seedConversionChildSchedule(supabase, {
          childBatchId:   target.id,
          recipeId:       target.recipe_id,
          volumeBbl:      newVolume,
          conversionDate: newDate ?? new Date().toISOString().split("T")[0],
        });
      } catch (seedErr) {
        console.error("[batch-conversions] Re-seeding child schedule failed (plan updated):", seedErr);
      }
    }
  }

  // Re-reserve the addition at the new volume (replaces the previous set;
  // silent no-op for unlinked pairs, exactly like the plan's creation).
  if (updates.volume_bbl != null) {
    try {
      await reserveConversionAdditions(supabase, {
        sourceBatchId: plan.source_batch_id,
        targetBatchId: plan.target_batch_id,
        volumeBbl:     newVolume,
      });
    } catch (reserveErr) {
      console.error("[batch-conversions] Re-reserving after edit failed (plan updated):", reserveErr);
    }
  }

  return NextResponse.json(updated);
}

// DELETE /api/production/batch-conversions/[id]
// Cancel a still-pending conversion plan. Releases what the plan reserved and,
// when the plan minted its own child that nothing else touched, removes the
// child too — a plan-born batch with no transfers, allocations, or other plans
// exists only as this plan's shadow.
export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  try { await requirePermission(CAP.brewingOperate); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const { id } = await params;

  const plan = await loadPlan(supabase, id);
  if (!plan) return NextResponse.json({ error: "Conversion plan not found" }, { status: 404 });
  if (plan.converted_at) {
    return NextResponse.json({ error: "This conversion has already been executed — cancel is only for pending plans." }, { status: 422 });
  }

  const { data: targetRow } = await supabase
    .from("brew_batches")
    .select("id, status, recipe_id, turns, volume_bbl, converted_volume_bbl, converted_from_batch_id, square_invoice_id")
    .eq("id", plan.target_batch_id)
    .maybeSingle();
  const target = targetRow as TargetBatch | null;

  const { error: deleteErr } = await supabase.from("batch_conversions").delete().eq("id", id);
  if (deleteErr) return NextResponse.json({ error: deleteErr.message }, { status: 500 });

  if (!target) return NextResponse.json({ cancelled: true, target_batch_deleted: false });

  // What the target should hold in reserve now depends on who else feeds it.
  const [{ data: otherPlans }, { count: transferCount }, { count: allocationCount }] = await Promise.all([
    supabase
      .from("batch_conversions")
      .select("id, source_batch_id, volume_bbl")
      .eq("target_batch_id", target.id)
      .is("converted_at", null)
      .order("created_at", { ascending: true }),
    supabase
      .from("batch_transfers")
      .select("id", { count: "exact", head: true })
      .or(`batch_id.eq.${target.id},to_batch_id.eq.${target.id}`),
    supabase
      .from("batch_allocations")
      .select("id", { count: "exact", head: true })
      .eq("batch_id", target.id),
  ]);

  const remainingPlans = (otherPlans ?? []) as Array<{ id: string; source_batch_id: string; volume_bbl: number }>;
  const planBorn = target.converted_from_batch_id === plan.source_batch_id && target.status === "planning";
  const untouched = (transferCount ?? 0) === 0 && (allocationCount ?? 0) === 0 && remainingPlans.length === 0;

  let targetBatchDeleted = false;
  if (remainingPlans.length > 0) {
    // Another pending plan still feeds this target — its reservation is the
    // one that should stand. Re-running it replaces whatever this plan held.
    try {
      await reserveConversionAdditions(supabase, {
        sourceBatchId: remainingPlans[0].source_batch_id,
        targetBatchId: target.id,
        volumeBbl:     Number(remainingPlans[0].volume_bbl),
      });
    } catch (reserveErr) {
      console.error("[batch-conversions] Re-reserving for surviving plan failed (plan cancelled):", reserveErr);
    }
  } else if (planBorn && untouched) {
    // The child was this plan's shadow: cancel its Square project (swallowing
    // already-cancelled), then delete it — FK cascades clean up the rest.
    if (target.square_invoice_id) {
      try {
        await cancelInvoice(target.square_invoice_id);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!msg.includes("CANCELED") && !msg.includes("NOT_FOUND")) {
          console.error("[batch-conversions] Cancelling child's Square project failed (child still deleted):", msg);
        }
      }
    }
    const { error: childErr } = await supabase.from("brew_batches").delete().eq("id", target.id);
    if (childErr) {
      console.error("[batch-conversions] Deleting plan-born child failed (plan cancelled):", childErr.message);
    } else {
      targetBatchDeleted = true;
    }
  } else if (!planBorn && target.status === "planning" && target.recipe_id) {
    // An ordinary pre-planned batch the plan pointed at: restore its own full
    // bill, which the plan's reservation had replaced with the conversion delta.
    await upsertCommitments(supabase, target.id, target.recipe_id, Math.max(1, Number(target.turns ?? 1)));
  } else {
    // Nothing will feed it through this plan any more; whatever the plan
    // reserved on it is moot.
    await releaseCommitments(supabase, target.id);
  }

  return NextResponse.json({ cancelled: true, target_batch_deleted: targetBatchDeleted });
}
