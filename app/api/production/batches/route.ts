import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createBatchSquareProject } from "@/lib/square/projects";
import { upsertCommitments } from "@/lib/production/commitments";
import { seedBatchActivities } from "@/lib/production/brewActivities";
import { batchFillBbl } from "@/lib/production/batchVolume";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  normalizeStage, slotTimestamp, validateBatchPlan,
  type PlanAllocationInput, type PlanSlotInput,
} from "@/lib/production/batchPlan";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from("brew_batches")
    .select("*, recipes(beer_name, expected_yield_bbl, partner:contract_brewing_partners(company_name)), batch_status_history(*), batch_brew_activity_log:brew_activities(*), converted_from_batch:converted_from_batch_id(id, beer_name, batch_number)")
    .order("planned_brew_date", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  try { await requirePermission(CAP.brewingOperate); } catch (res) { return res as Response; }


  const supabase = await createSupabaseServerClient();

  const body = await req.json();
  const {
    beer_name, planned_brew_date, expected_delivery_date, turns,
    status = "planning", notes, recipe_id,
    converted_from_batch_id, converted_volume_bbl,
  } = body;
  // Optional plan (Intake's scheduler): tank bookings and allocations saved WITH
  // the batch. Checked in full before anything is written — see lib/production/batchPlan.
  const schedule: PlanSlotInput[] = Array.isArray(body.schedule) ? body.schedule : [];
  const allocations: PlanAllocationInput[] = Array.isArray(body.allocations) ? body.allocations : [];

  if (!recipe_id) return NextResponse.json({ error: "recipe_id is required" }, { status: 400 });

  // A brewed batch's volume is the brewhouse fill, derived from turns — never
  // the caller's number (see lib/production/batchVolume.ts). Only a
  // conversion-born batch carries a typed volume: what the conversion delivers.
  const conversionVolume = Number(body.volume_bbl ?? converted_volume_bbl);
  if (converted_from_batch_id && !(conversionVolume > 0)) {
    return NextResponse.json({ error: "A conversion batch needs its delivered volume." }, { status: 400 });
  }
  const volume_bbl = converted_from_batch_id ? conversionVolume : batchFillBbl(turns);
  if (allocations.length > 0) {
    try { await requirePermission(CAP.exportOperate); } catch (res) { return res as Response; }
  }
  if (schedule.length > 0 || allocations.length > 0) {
    const commitmentIds = [...new Set(allocations.map((a) => a.contract_request_id).filter((id): id is string => !!id))];
    const [busyRes, tanksRes, commitmentsRes] = await Promise.all([
      supabase.from("batch_schedule_entries")
        .select("equipment_id, planned_start, planned_end, actual_start, actual_end")
        .is("cancelled_at", null).not("equipment_id", "is", null),
      supabase.from("equipment").select("id, name"),
      commitmentIds.length > 0
        ? supabase.from("commitments").select("id, channel").in("id", commitmentIds)
        : Promise.resolve({ data: [] as { id: string; channel: string | null }[], error: null }),
    ]);
    const readErr = busyRes.error ?? tanksRes.error ?? commitmentsRes.error;
    if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });
    const problem = validateBatchPlan({
      schedule, allocations,
      commitmentChannelById: new Map((commitmentsRes.data ?? []).map((c) => [c.id as string, c.channel as string | null])),
      busy: (busyRes.data ?? []).map((e) => ({
        equipment_id: e.equipment_id as string | null,
        start: (e.actual_start ?? e.planned_start) as string,
        end: (e.actual_end ?? e.planned_end) as string,
      })),
      tankNameById: new Map((tanksRes.data ?? []).map((t) => [t.id as string, t.name as string])),
    });
    if (problem) return NextResponse.json({ error: problem }, { status: 422 });
  }

  // Always fetch recipe lead time — used for delivery date and brewhouse schedule entry.
  const { data: recipeData, error: recipeErr } = await supabase
    .from("recipes")
    .select("days_brewhouse, days_fermenter, days_brite")
    .eq("id", recipe_id)
    .single();
  if (recipeErr) return NextResponse.json({ error: recipeErr.message }, { status: 500 });

  // Auto-derive expected_delivery_date from recipe lead time when not explicitly
  // provided. A converted batch skips brewhouse/fermenting entirely — only the
  // remaining (brite/conditioning) lead time applies from its planned_brew_date,
  // which for a conversion is really the receiving tank's planned start.
  let resolvedDeliveryDate: string | null = expected_delivery_date || null;
  if (!resolvedDeliveryDate && planned_brew_date && recipeData) {
    const leadDays = converted_from_batch_id
      ? (recipeData.days_brite ?? 0)
      : (recipeData.days_brewhouse ?? 0) + (recipeData.days_fermenter ?? 0) + (recipeData.days_brite ?? 0);
    if (leadDays > 0) {
      const brewDate = new Date(planned_brew_date);
      brewDate.setUTCDate(brewDate.getUTCDate() + leadDays);
      resolvedDeliveryDate = brewDate.toISOString().slice(0, 10);
    }
  }

  // One transaction: create the batch (batch_number assigned by trigger), log
  // the initial status, and consume recipe ingredients with cost tracking.
  const { data: batch, error: batchErr } = await supabase
    .rpc("create_batch_with_consumption", {
      p_beer_name:              beer_name,
      p_planned_brew_date:      planned_brew_date ?? null,
      p_expected_delivery_date: resolvedDeliveryDate,
      p_volume_bbl:             volume_bbl,
      p_turns:                  turns ?? 1,
      p_status:                 status,
      p_notes:                  notes ?? null,
      p_recipe_id:              recipe_id,
    })
    .single<{ id: string }>();

  if (batchErr) return NextResponse.json({ error: batchErr.message }, { status: 500 });

  // Reserve ingredient stock for this batch's planning period.
  await upsertCommitments(supabase, batch.id, recipe_id, Math.max(1, Number(turns ?? 1)));

  // Persist extra fields not handled by the RPC
  const extras: Record<string, unknown> = {};
  if (resolvedDeliveryDate)    extras.expected_delivery_date    = resolvedDeliveryDate;
  // Link and volume in ONE write: the volume trigger only leaves a typed volume
  // alone on a row that is already a conversion batch.
  if (converted_from_batch_id) { extras.converted_from_batch_id = converted_from_batch_id; extras.volume_bbl = volume_bbl; }
  if (converted_volume_bbl)    extras.converted_volume_bbl     = converted_volume_bbl;
  if (Object.keys(extras).length) {
    const { error: extrasErr } = await supabase.from("brew_batches").update(extras).eq("id", batch.id);
    if (extrasErr) return NextResponse.json({ error: extrasErr.message }, { status: 500 });
  }

  // Seed a brewhouse schedule entry so the scheduler sees it as occupied.
  // equipment_id is null at creation time (tank assigned later via tank-assignments).
  // A batch created from a conversion never has an upstream brewhouse stage —
  // planned_brew_date is only set on it as a NOT NULL placeholder.
  // A plan that books the brewhouse itself replaces this placeholder — two
  // brewhouse rows on one batch is what the old three-call save left behind.
  const planBooksBrewhouse = schedule.some((s) => normalizeStage(s.stage) === "brewhouse");
  if (planned_brew_date && !converted_from_batch_id && !planBooksBrewhouse) {
    const brewhouseDays = Math.max(1, recipeData?.days_brewhouse ?? 1);
    const brewEnd = new Date(planned_brew_date);
    brewEnd.setUTCDate(brewEnd.getUTCDate() + brewhouseDays);
    await supabase.from("batch_schedule_entries").insert({
      batch_id:      batch.id,
      equipment_id:  null,
      stage:         "brewhouse",
      planned_start: planned_brew_date,
      planned_end:   brewEnd.toISOString().slice(0, 10),
      notes:         "Auto-created on batch planning",
    });
  }

  // Save the plan. Anything that fails here takes the batch with it, so a
  // retry can never produce a duplicate or a batch with half its bookings.
  if (schedule.length > 0 || allocations.length > 0) {
    const planErr = await (async (): Promise<string | null> => {
      if (schedule.length > 0) {
        const { error } = await supabase.from("batch_schedule_entries").insert(schedule.map((s) => ({
          batch_id:      batch.id,
          equipment_id:  s.equipment_id,
          stage:         normalizeStage(s.stage),
          planned_start: slotTimestamp(s.planned_start),
          planned_end:   slotTimestamp(s.planned_end),
          volume_bbl:    s.volume_bbl ?? null,
        })));
        if (error) return `tank bookings: ${error.message}`;
      }
      if (allocations.length > 0) {
        const { error } = await supabase.from("batch_allocations").insert(allocations.map((a) => ({
          batch_id:            batch.id,
          channel:             a.channel,
          percentage:          Number(a.percentage),
          partner_id:          a.partner_id || null,
          contract_request_id: a.contract_request_id || null,
          notes:               a.notes || null,
        })));
        if (error) return `allocations: ${error.message}`;
      }
      return null;
    })();
    if (planErr) {
      // Admin client: hard delete is admin-only, but this batch is seconds old
      // and has nothing on record. Children cascade.
      const { error: undoErr } = await createSupabaseAdminClient().from("brew_batches").delete().eq("id", batch.id);
      return NextResponse.json({
        error: undoErr
          ? `Could not save the ${planErr}. The half-saved batch could not be removed (${undoErr.message}) — delete it from the Batch Log before retrying.`
          : `Could not save the ${planErr}. Nothing was saved — fix the problem and commit again.`,
      }, { status: 500 });
    }
  }

  // Seed the new batch's activity log from the recipe's default activities.
  const { data: templates, error: templatesErr } = await supabase
    .from("brew_activities")
    .select("sort_order, activity, time_label, temp, temp_unit, amount, amount_unit, vsp")
    .eq("recipe_id", recipe_id)
    .order("sort_order");
  if (templatesErr) return NextResponse.json({ error: templatesErr.message }, { status: 500 });
  if (templates && templates.length > 0) {
    const { error: logErr } = await supabase
      .from("brew_activities")
      .insert(seedBatchActivities(templates, batch.id));
    if (logErr) return NextResponse.json({ error: logErr.message }, { status: 500 });
  }

  // Create a Square Invoice ("project") for this batch — shared with the
  // conversion child factory so the two paths can never diverge. Non-blocking.
  let squareInvoiceId: string | null = null;
  if (resolvedDeliveryDate) {
    squareInvoiceId = await createBatchSquareProject(supabase, {
      batchId: batch.id,
      beerName: beer_name,
      volumeBbl: volume_bbl,
      plannedBrewDate: planned_brew_date,
      expectedDeliveryDate: resolvedDeliveryDate,
      recipeId: recipe_id,
    });
  }

  const { data, error } = await supabase
    .from("brew_batches")
    .select("*, recipes(beer_name, expected_yield_bbl, partner:contract_brewing_partners(company_name)), batch_status_history(*), batch_brew_activity_log:brew_activities(*), converted_from_batch:converted_from_batch_id(id, beer_name, batch_number)")
    .eq("id", batch.id)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ...data, square_invoice_id: squareInvoiceId }, { status: 201 });
}
