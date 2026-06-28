import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from("recipe_square_links")
    .select("*, recipes(beer_name), packaging_items(id, name, type, volume_fl_oz), packaging_variations(id, name)")
    .order("created_at");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  try { await requireRole(["brewer"]); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();

  const {
    recipe_id, packaging, variation_id,
    packaging_item_id: clientPackagingItemId,
    square_variation_id, square_item_id, variation_name, item_name,
  } = await req.json();

  if (!recipe_id || !packaging || !square_variation_id) {
    return NextResponse.json(
      { error: "recipe_id, packaging, and square_variation_id are required" },
      { status: 400 }
    );
  }

  if (packaging !== "draft" && packaging !== "keg" && packaging !== "can") {
    return NextResponse.json({ error: "packaging must be 'draft', 'keg', or 'can'" }, { status: 400 });
  }

  // Variation-grain is the source of truth for keg/can. A keg/can POST must
  // carry EITHER a variation_id (new RecipeLinkMatrix flow) OR a
  // packaging_item_id (legacy SquareLinkManager flow, kept for backward
  // compatibility). draft is recipe-grain and must NOT carry a variation_id.
  if (packaging === "draft" && variation_id) {
    return NextResponse.json(
      { error: "draft links must not carry a variation_id" },
      { status: 400 }
    );
  }
  if ((packaging === "keg" || packaging === "can") && !variation_id && !clientPackagingItemId) {
    return NextResponse.json(
      { error: "variation_id (or packaging_item_id) is required for keg and can links" },
      { status: 400 }
    );
  }

  // When a variation_id is supplied, derive the container from it so the
  // denormalized packaging_item_id column stays populated for legacy readers.
  // Source of truth is variation_id. (recipe_square_links has no
  // packaging_format column in the live schema, so format is not stored here.)
  let packaging_item_id: string | null = clientPackagingItemId ?? null;
  if (variation_id) {
    const { data: pv, error: pvErr } = await supabase
      .from("packaging_variations")
      .select("container_id")
      .eq("id", variation_id)
      .single();
    if (pvErr || !pv) {
      return NextResponse.json({ error: "variation_id not found" }, { status: 400 });
    }
    packaging_item_id = pv.container_id;
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
      variation_id: variation_id || null,
      packaging_item_id: packaging_item_id || null,
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
