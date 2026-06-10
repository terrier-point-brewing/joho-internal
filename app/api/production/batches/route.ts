import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSquareProject } from "@/lib/square/projects";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from("brew_batches")
    .select("*, recipes(beer_name, brewery, brew_time_weeks, expected_yield_bbl), batch_status_history(*), batch_brew_activity_log(*)")
    .order("planned_brew_date", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  const supabase = await createSupabaseServerClient();

  const body = await req.json();
  const { beer_name, planned_brew_date, expected_delivery_date, volume_bbl, turns, status = "planning", notes, recipe_id } = body;

  if (!recipe_id) return NextResponse.json({ error: "recipe_id is required" }, { status: 400 });

  // Auto-derive expected_delivery_date from recipe lead time when not explicitly provided.
  let resolvedDeliveryDate: string | null = expected_delivery_date || null;
  if (!resolvedDeliveryDate && planned_brew_date) {
    const { data: recipeData, error: recipeErr } = await supabase
      .from("recipes")
      .select("days_brewhouse, days_fermenter, days_brite")
      .eq("id", recipe_id)
      .single();
    if (recipeErr) return NextResponse.json({ error: recipeErr.message }, { status: 500 });
    if (recipeData) {
      const leadDays = (recipeData.days_brewhouse ?? 0) + (recipeData.days_fermenter ?? 0) + (recipeData.days_brite ?? 0);
      if (leadDays > 0) {
        const brewDate = new Date(planned_brew_date);
        brewDate.setUTCDate(brewDate.getUTCDate() + leadDays);
        resolvedDeliveryDate = brewDate.toISOString().slice(0, 10);
      }
    }
  }

  // One transaction: create the batch (batch_number assigned by trigger), log
  // the initial status, and consume recipe ingredients with cost tracking.
  const { data: batch, error: batchErr } = await supabase
    .rpc("create_batch_with_consumption", {
      p_beer_name:              beer_name,
      p_planned_brew_date:      planned_brew_date,
      p_expected_delivery_date: resolvedDeliveryDate,
      p_volume_bbl:             volume_bbl,
      p_turns:                  turns,
      p_status:                 status,
      p_notes:                  notes,
      p_recipe_id:              recipe_id,
    })
    .single<{ id: string }>();

  if (batchErr) return NextResponse.json({ error: batchErr.message }, { status: 500 });

  // Explicitly persist expected_delivery_date — the RPC may not forward it,
  // so we write it directly after creation to guarantee it's saved.
  if (resolvedDeliveryDate) {
    const { error: deliveryErr } = await supabase
      .from("brew_batches")
      .update({ expected_delivery_date: resolvedDeliveryDate })
      .eq("id", batch.id);
    if (deliveryErr) return NextResponse.json({ error: deliveryErr.message }, { status: 500 });
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

      // Persist invoice ID — requires: ALTER TABLE brew_batches ADD COLUMN IF NOT EXISTS square_invoice_id text;
      await supabase
        .from("brew_batches")
        .update({ square_invoice_id: squareInvoiceId })
        .eq("id", batch.id);
    } catch (err) {
      // Square invoice creation is non-blocking — log and continue
      console.error("[Square] Failed to create project invoice:", err);
    }
  }

  const { data, error } = await supabase
    .from("brew_batches")
    .select("*, recipes(beer_name, brewery, brew_time_weeks, expected_yield_bbl), batch_status_history(*), batch_brew_activity_log(*)")
    .eq("id", batch.id)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ...data, square_invoice_id: squareInvoiceId }, { status: 201 });
}
