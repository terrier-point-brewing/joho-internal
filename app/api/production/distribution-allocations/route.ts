import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";

export async function GET() {
  const { data, error } = await supabase
    .from("distribution_allocations")
    .select("*, recipes(beer_name), contract_brewing_partners(company_name), packaging_items(id, name, volume_fl_oz)")
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  const b = await req.json();
  const { recipe_id, packaging, quantity, unit, cadence } = b;
  if (!packaging || quantity == null || !unit || !cadence) {
    return NextResponse.json({ error: "packaging, quantity, unit, and cadence are required" }, { status: 400 });
  }
  if (cadence === "one_time" && !b.delivery_date) {
    return NextResponse.json({ error: "delivery_date is required for one-time allocations" }, { status: 400 });
  }
  if (cadence === "recurring" && (!b.start_date || !b.recurrence)) {
    return NextResponse.json({ error: "start_date and recurrence are required for recurring allocations" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("distribution_allocations")
    .insert({
      recipe_id: recipe_id || null,
      packaging,
      quantity,
      unit,
      packaging_item_id: b.packaging_item_id || null,
      cadence,
      delivery_date: cadence === "one_time" ? b.delivery_date : null,
      start_date: cadence === "recurring" ? b.start_date : null,
      recurrence: cadence === "recurring" ? b.recurrence : null,
      end_date: cadence === "recurring" ? b.end_date || null : null,
      partner_id: b.partner_id || null,
      notes: b.notes || null,
      status: b.status || "active",
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}

export async function PATCH(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const b = await req.json();
  const allowed = ["status", "notes", "quantity", "delivery_date", "start_date", "end_date", "recurrence", "partner_id", "packaging_item_id"];
  const patch: Record<string, unknown> = {};
  for (const k of allowed) if (k in b) patch[k] = b[k];
  if (Object.keys(patch).length === 0) return NextResponse.json({ error: "no fields to update" }, { status: 400 });
  const { data, error } = await supabase.from("distribution_allocations").update(patch).eq("id", id).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const { error } = await supabase.from("distribution_allocations").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
