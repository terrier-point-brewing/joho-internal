import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";

export async function GET() {
  const { data, error } = await supabase
    .from("distribution_allocations")
    .select("*, recipes(beer_name), contract_brewing_partners(company_name)")
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
      cadence,
      delivery_date: cadence === "one_time" ? b.delivery_date : null,
      start_date: cadence === "recurring" ? b.start_date : null,
      recurrence: cadence === "recurring" ? b.recurrence : null,
      end_date: cadence === "recurring" ? b.end_date || null : null,
      partner_id: b.partner_id || null,
      notes: b.notes || null,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const { error } = await supabase.from("distribution_allocations").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
