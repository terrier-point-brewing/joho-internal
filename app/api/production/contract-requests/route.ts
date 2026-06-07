import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";

export async function GET() {
  const { data, error } = await supabase
    .from("contract_brewing_requests")
    .select("*, recipes(beer_name), contract_brewing_partners(company_name), packaging_items(id, name, volume_fl_oz)")
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  const b = await req.json();
  const { beer_style, partner_id, volume_bbl } = b;
  if (!beer_style || volume_bbl == null) {
    return NextResponse.json({ error: "beer_style and volume_bbl are required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("contract_brewing_requests")
    .insert({
      recipe_id: b.recipe_id || null,
      beer_style,
      partner_id: partner_id || null,
      volume_bbl,
      desired_delivery_date: b.desired_delivery_date || null,
      status: b.status || "open",
      notes: b.notes || null,
      packaging_item_id: b.packaging_item_id || null,
      packaging_qty: b.packaging_qty || null,
      channel: b.channel || "contract_brewing",
      cadence: b.cadence || "one_time",
      recurrence: b.recurrence || null,
      start_date: b.start_date || null,
      end_date: b.end_date || null,
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
  const allowed = ["status", "notes", "volume_bbl", "desired_delivery_date", "partner_id", "packaging_item_id", "packaging_qty", "channel", "cadence", "recurrence", "start_date", "end_date"];
  const patch: Record<string, unknown> = {};
  for (const k of allowed) if (k in b) patch[k] = b[k];
  if (Object.keys(patch).length === 0) return NextResponse.json({ error: "no fields to update" }, { status: 400 });
  const { data, error } = await supabase.from("contract_brewing_requests").update(patch).eq("id", id).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const { error } = await supabase.from("contract_brewing_requests").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
