import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from("recipe_packaging_variations")
    .select(`
      id, recipe_id, variation_id, created_at,
      packaging_variations(
        id, name, container_id, format, partner_id, total_volume_fl_oz, is_active,
        packaging_items:container_id(id, name, type, volume_fl_oz),
        contract_brewing_partners(id, company_name)
      )
    `)
    .order("created_at");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  try { await requireRole(["brewer"]); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const { recipe_id, variation_id } = await req.json();
  if (!recipe_id || !variation_id) {
    return NextResponse.json({ error: "recipe_id and variation_id are required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("recipe_packaging_variations")
    .insert({ recipe_id, variation_id })
    .select("*, packaging_variations(*)")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  try { await requireRole(["brewer"]); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const { error } = await supabase.from("recipe_packaging_variations").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
