import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSquareProject } from "@/lib/square/projects";
import { upsertCommitments } from "@/lib/production/commitments";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from("brew_batches")
    .select("*, recipes(beer_name, brewery, brew_time_weeks, expected_yield_bbl), batch_status_history(*), batch_brew_activity_log(*), converted_from_batch:converted_from_batch_id(id, beer_name, batch_number)")
    .order("planned_brew_date", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  try { await requireRole("brewer"); } catch (res) { return res as Response; }


  const supabase = await createSupabaseServerClient();

  const body = await req.json();
  const {
    beer_name, planned_brew_date, expected_delivery_date, volume_bbl, turns,
    status = "planning", notes, recipe_id,
    converted_from_batch_id, converted_volume_bbl,
  } = body;

  if (!recipe_id) return NextResponse.json({ error: "recipe_id is required" }, { status: 400 });

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
  await upsertCommitments(supabase, batch.id, recipe_id, volume_bbl);

  // Persist extra fields not handled by the RPC
  const extras: Record<string, unknown> = {};
  if (resolvedDeliveryDate)    extras.expected_delivery_date    = resolvedDeliveryDate;
  if (converted_from_batch_id) extras.converted_from_batch_id  = converted_from_batch_id;
  if (converted_volume_bbl)    extras.converted_volume_bbl     = converted_volume_bbl;
  if (Object.keys(extras).length) {
    const { error: extrasErr } = await supabase.from("brew_batches").update(extras).eq("id", batch.id);
    if (extrasErr) return NextResponse.json({ error: extrasErr.message }, { status: 500 });
  }

  // Seed a brewhouse schedule entry so the scheduler sees it as occupied.
  // equipment_id is null at creation time (tank assigned later via tank-assignments).
  // A batch created from a conversion never has an upstream brewhouse stage —
  // planned_brew_date is only set on it as a NOT NULL placeholder.
  if (planned_brew_date && !converted_from_batch_id) {
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

  // Copy recipe activity templates into the new batch's activity log
  const { data: templates, error: templatesErr } = await supabase
    .from("recipe_brew_activity_templates")
    .select("*")
    .eq("recipe_id", recipe_id)
    .order("sort_order");
  if (templatesErr) return NextResponse.json({ error: templatesErr.message }, { status: 500 });
  if (templates && templates.length > 0) {
    const { error: logErr } = await supabase.from("batch_brew_activity_log").insert(
      templates.map((t: {
        id: string; sort_order: number; activity: string; time_label: string | null;
        temp: number | null; temp_unit?: string | null;
        amount: number | null; amount_unit?: string | null;
        vsp?: number | null;
      }) => ({
        batch_id:    batch.id,
        template_id: t.id,
        sort_order:  t.sort_order,
        activity:    t.activity,
        time_label:  t.time_label,
        temp:        t.temp,
        temp_unit:   t.temp_unit ?? "F",
        amount:      t.amount,
        amount_unit: t.amount_unit ?? null,
        vsp:         t.vsp ?? null,
      }))
    );
    if (logErr) return NextResponse.json({ error: logErr.message }, { status: 500 });
  }

  // Create a Square Invoice ("project") for this batch.
  // Look up the recipe's partner to get their square_customer_id.
  let squareInvoiceId: string | null = null;
  if (resolvedDeliveryDate) {
    try {
      const { data: recipeRow } = await supabase
        .from("recipes")
        .select("brewery")
        .eq("id", recipe_id)
        .single();

      let squareCustomerId: string | null = null;
      if (recipeRow?.brewery) {
        const { data: partner } = await supabase
          .from("contract_brewing_partners")
          .select("square_customer_id")
          .eq("company_name", recipeRow.brewery)
          .single();
        squareCustomerId = partner?.square_customer_id ?? null;
      }

      const result = await createSquareProject({
        beerName: beer_name,
        volumeBbl: volume_bbl,
        plannedBrewDate: planned_brew_date,
        expectedDeliveryDate: resolvedDeliveryDate,
        squareCustomerId,
      });

      squareInvoiceId = result.invoiceId;

      const { error: invIdErr } = await supabase
        .from("brew_batches")
        .update({ square_invoice_id: squareInvoiceId })
        .eq("id", batch.id);
      if (invIdErr) console.error("[Square] Failed to persist square_invoice_id:", invIdErr.message);
    } catch (err) {
      // Square invoice creation is non-blocking — log and continue
      console.error("[Square] Failed to create project invoice:", err);
    }
  }

  const { data, error } = await supabase
    .from("brew_batches")
    .select("*, recipes(beer_name, brewery, brew_time_weeks, expected_yield_bbl), batch_status_history(*), batch_brew_activity_log(*), converted_from_batch:converted_from_batch_id(id, beer_name, batch_number)")
    .eq("id", batch.id)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ...data, square_invoice_id: squareInvoiceId }, { status: 201 });
}
