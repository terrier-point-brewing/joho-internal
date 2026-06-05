import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { createSquareProject } from "@/lib/square/projects";

export async function GET() {
  const { data, error } = await supabase
    .from("brew_batches")
    .select("*, recipes(beer_name, brewery, brew_time_weeks, expected_yield_bbl), batch_status_history(*), planned_allocations(*), batch_brew_activity_log(*)")
    .order("planned_brew_date", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { beer_name, planned_brew_date, expected_delivery_date, volume_bbl, turns, status = "planning", notes, recipe_id } = body;

  if (!recipe_id) return NextResponse.json({ error: "recipe_id is required" }, { status: 400 });

  // One transaction: create the batch (batch_number assigned by trigger), log
  // the initial status, and consume recipe ingredients with cost tracking.
  const { data: batch, error: batchErr } = await supabase
    .rpc("create_batch_with_consumption", {
      p_beer_name:              beer_name,
      p_planned_brew_date:      planned_brew_date,
      p_expected_delivery_date: expected_delivery_date || null,
      p_volume_bbl:             volume_bbl,
      p_turns:                  turns,
      p_status:                 status,
      p_notes:                  notes,
      p_recipe_id:              recipe_id,
    })
    .single<{ id: string }>();

  if (batchErr) return NextResponse.json({ error: batchErr.message }, { status: 500 });

  // Copy recipe activity templates into the new batch's activity log
  const { data: templates } = await supabase
    .from("recipe_brew_activity_templates")
    .select("*")
    .eq("recipe_id", recipe_id)
    .order("sort_order");
  if (templates && templates.length > 0) {
    await supabase.from("batch_brew_activity_log").insert(
      templates.map((t: { sort_order: number; activity: string; time_label: string | null; temp: number | null; amount: number | null }) => ({
        batch_id: batch.id,
        sort_order: t.sort_order,
        activity: t.activity,
        time_label: t.time_label,
        temp: t.temp,
        amount: t.amount,
      }))
    );
  }

  // Create a Square Invoice ("project") for this batch.
  // Look up the recipe's partner to get their square_customer_id.
  let squareInvoiceId: string | null = null;
  if (expected_delivery_date) {
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
        expectedDeliveryDate: expected_delivery_date,
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
    .select("*, recipes(beer_name, brewery, brew_time_weeks, expected_yield_bbl), batch_status_history(*), planned_allocations(*), batch_brew_activity_log(*)")
    .eq("id", batch.id)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ...data, square_invoice_id: squareInvoiceId }, { status: 201 });
}
