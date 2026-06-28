import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from("recipe_square_links")
    .select("*, recipes(beer_name), packaging_items(id, name, type, volume_fl_oz)")
    .order("created_at");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  try { await requireRole(["brewer"]); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();

  const {
    recipe_id, packaging, packaging_item_id,
    packaging_format,
    square_variation_id, square_item_id, variation_name, item_name,
  } = await req.json();

  if (!recipe_id || !packaging || !square_variation_id) {
    return NextResponse.json(
      { error: "recipe_id, packaging, and square_variation_id are required" },
      { status: 400 }
    );
  }

  // keg/can require a packaging_item_id
  if ((packaging === "keg" || packaging === "can") && !packaging_item_id) {
    return NextResponse.json(
      { error: "packaging_item_id is required for keg and can links" },
      { status: 400 }
    );
  }

  // can links require a packaging_format; keg/draft links must not have one
  if (packaging === "can" && !packaging_format) {
    return NextResponse.json(
      { error: "packaging_format is required for can links ('loose', '4-pack', '6-pack', or 'case')" },
      { status: 400 }
    );
  }
  if (packaging !== "can" && packaging_format) {
    return NextResponse.json(
      { error: "packaging_format is only valid for can links" },
      { status: 400 }
    );
  }

  const VALID_FORMATS = ["loose", "4-pack", "6-pack", "case"];
  if (packaging_format && !VALID_FORMATS.includes(packaging_format)) {
    return NextResponse.json(
      { error: `packaging_format must be one of: ${VALID_FORMATS.join(", ")}` },
      { status: 400 }
    );
  }

  // Resolve catalog FKs from the master tables
  let catalog_item_id: string | null = null;
  let catalog_variation_id: string | null = null;

  if (square_item_id) {
    const { data: master } = await supabase
      .from("square_catalog_items")
      .select("id")
      .eq("square_item_id", square_item_id)
      .single();
    catalog_item_id = master?.id ?? null;
  }

  if (square_variation_id) {
    const { data: variation } = await supabase
      .from("square_catalog_variations")
      .select("id")
      .eq("square_variation_id", square_variation_id)
      .single();
    catalog_variation_id = variation?.id ?? null;
  }

  const { data, error } = await supabase
    .from("recipe_square_links")
    .insert({
      recipe_id,
      packaging,
      packaging_item_id: packaging_item_id || null,
      packaging_format: packaging_format || null,
      square_variation_id,
      square_item_id: square_item_id || null,
      variation_name: variation_name || null,
      item_name: item_name || null,
      catalog_item_id,
      catalog_variation_id,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  try { await requireRole(["brewer"]); } catch (res) { return res as Response; }


  const supabase = await createSupabaseServerClient();

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const { error } = await supabase.from("recipe_square_links").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
