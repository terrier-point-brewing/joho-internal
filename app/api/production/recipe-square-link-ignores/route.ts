import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  // brewer (production) and manager (taproom) both edit Square item mappings.
  try { await requireRole(["brewer", "manager"]); } catch (res) { return res as Response; }

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

  // Idempotent: re-ignoring an already-ignored cell returns the existing row.
  const conflict = packaging === "draft" ? "recipe_id" : "recipe_id,variation_id";
  const { data, error } = await supabase
    .from("recipe_square_link_ignores")
    .upsert(
      { recipe_id, packaging, variation_id: variation_id || null },
      { onConflict: conflict, ignoreDuplicates: false }
    )
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  try { await requireRole(["brewer", "manager"]); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const { error } = await supabase.from("recipe_square_link_ignores").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
