import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  // brewer (production) and manager (taproom) both edit Square item mappings.
  try { await requirePermission(CAP.productionSettingsOperate); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const { recipe_id, packaging, variation_id } = await req.json();

  if (!recipe_id || !packaging) {
    return NextResponse.json({ error: "recipe_id and packaging are required" }, { status: 400 });
  }
  if (packaging !== "draft" && packaging !== "keg" && packaging !== "can") {
    return NextResponse.json({ error: "packaging must be 'draft', 'keg', or 'can'" }, { status: 400 });
  }
  if (packaging === "draft" && variation_id) {
    return NextResponse.json({ error: "draft ignores must not carry a variation_id" }, { status: 400 });
  }
  if ((packaging === "keg" || packaging === "can") && !variation_id) {
    return NextResponse.json({ error: "variation_id is required for keg and can ignores" }, { status: 400 });
  }

  const normalizedVariationId = variation_id || null;

  // Both uniqueness rules are enforced by PARTIAL indexes (see the 20260814 migration),
  // which Postgres can't match via upsert()'s plain column-list ON CONFLICT target.
  // Insert instead, and on a unique violation (23505) treat it as the idempotent
  // "already ignored" case and return the existing row.
  const { data: inserted, error: insertError } = await supabase
    .from("recipe_square_link_ignores")
    .insert({ recipe_id, packaging, variation_id: normalizedVariationId })
    .select()
    .single();

  if (!insertError) return NextResponse.json(inserted, { status: 201 });
  if (insertError.code !== "23505") {
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  let existingQuery = supabase.from("recipe_square_link_ignores").select().eq("recipe_id", recipe_id);
  existingQuery = packaging === "draft"
    ? existingQuery.eq("packaging", "draft")
    : existingQuery.eq("variation_id", normalizedVariationId);
  const { data: existing, error: fetchError } = await existingQuery.single();

  if (fetchError) return NextResponse.json({ error: fetchError.message }, { status: 500 });
  return NextResponse.json(existing, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  try { await requirePermission(CAP.productionSettingsOperate); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const { error } = await supabase.from("recipe_square_link_ignores").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
