import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requireRole("brewer"); } catch (res) { return res as Response; }


  const supabase = await createSupabaseServerClient();

  const { id } = await params;
  const body = await req.json();
  const { type, name, partner_id, supplier_id, unit_cost, volume_fl_oz, can_count, is_default } = body;

  // Non-keg types: one default per type — clear any existing default of this type first (excluding self)
  if (is_default && type !== "keg") {
    await supabase.from("packaging_items").update({ is_default: false }).eq("type", type).eq("is_default", true).neq("id", id);
  }

  const { data, error } = await supabase
    .from("packaging_items")
    .update({
      type,
      name,
      partner_id: partner_id || null,
      supplier_id: supplier_id || null,
      unit_cost: unit_cost != null ? parseFloat(unit_cost) : null,
      volume_fl_oz: volume_fl_oz != null ? parseFloat(volume_fl_oz) : null,
      can_count: can_count != null ? parseInt(can_count) : null,
      is_default: is_default ?? false,
    })
    .eq("id", id)
    .select("*, contract_brewing_partners(company_name), suppliers(company_name)")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requireRole("brewer"); } catch (res) { return res as Response; }


  const supabase = await createSupabaseServerClient();

  const { id } = await params;
  const { error } = await supabase.from("packaging_items").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
