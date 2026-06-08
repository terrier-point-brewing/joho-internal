import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function GET() {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from("packaging_items")
    .select("*, contract_brewing_partners(company_name), suppliers(company_name)")
    .order("type")
    .order("name");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  const supabase = await createSupabaseServerClient();

  const body = await req.json();
  const { type, name, partner_id, supplier_id, unit_cost, volume_fl_oz, can_count, is_default } = body;

  // Non-keg types: one default per type — clear existing default first
  if (is_default && type !== "keg") {
    await supabase.from("packaging_items").update({ is_default: false }).eq("type", type).eq("is_default", true);
  }

  const { data, error } = await supabase
    .from("packaging_items")
    .insert({
      type,
      name,
      partner_id: partner_id || null,
      supplier_id: supplier_id || null,
      unit_cost: unit_cost != null ? parseFloat(unit_cost) : null,
      volume_fl_oz: volume_fl_oz != null ? parseFloat(volume_fl_oz) : null,
      can_count: can_count != null ? parseInt(can_count) : null,
      is_default: is_default ?? false,
    })
    .select("*, contract_brewing_partners(company_name), suppliers(company_name)")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}
