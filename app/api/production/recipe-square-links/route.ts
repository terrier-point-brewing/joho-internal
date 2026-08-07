import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { ensureCatalogItemMirrored } from "@/lib/square/ensureCatalogItem";
import { fetchMappingGrid } from "@/lib/production/mappingGridData";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const supabase = await createSupabaseServerClient();

  // Legacy flat response (existing callers)
  if (!req.nextUrl.searchParams.has("grid")) {
    const { data, error } = await supabase
      .from("recipe_square_links")
      .select("*, recipes(beer_name), packaging_items(id, name, type, volume_fl_oz), packaging_variations(id, name)")
      .order("created_at");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data);
  }

  // Grid response (?grid=1)
  try {
    return NextResponse.json(await fetchMappingGrid(supabase));
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  // brewer (production) and manager (taproom) are scoped siblings — both edit
  // Square item mappings, from the Production Settings and Taproom Settings screens.
  try { await requirePermission(CAP.catalogOperate); } catch (res) { return res as Response; }

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

  // Draft is recipe-grain (one slot): replace any existing draft link.
  // Keg/can with variation_id: replace any existing link for this recipe+variation
  // so the caller can re-link without having to remove first.
  if (packaging === "draft") {
    await supabase
      .from("recipe_square_links")
      .delete()
      .eq("recipe_id", recipe_id)
      .eq("packaging", "draft");
    // A cell is never both linked and ignored — clear any stale draft ignore.
    await supabase
      .from("recipe_square_link_ignores")
      .delete()
      .eq("recipe_id", recipe_id)
      .eq("packaging", "draft");
  } else if (variation_id) {
    await supabase
      .from("recipe_square_links")
      .delete()
      .eq("recipe_id", recipe_id)
      .eq("square_variation_id", square_variation_id);
    await supabase
      .from("recipe_square_link_ignores")
      .delete()
      .eq("recipe_id", recipe_id)
      .eq("variation_id", variation_id);
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

  // The picker above reads Square live; everything downstream reads the mirror.
  // Pull the linked item into the mirror now, or the two resolutions below come
  // back null and the link is invisible to every backend consumer until someone
  // clicks "Refresh from Square". Best effort — a link is still correct even if
  // Square is unreachable. See lib/square/ensureCatalogItem.ts.
  let mirrorWarning: string | undefined;
  if (square_item_id && square_variation_id) {
    // Bust the 5-minute live-catalog cache first: an item created within that
    // window would otherwise be absent from the very fetch meant to mirror it.
    revalidateTag("square-catalog", "max");
    const ensured = await ensureCatalogItemMirrored(createSupabaseAdminClient(), {
      squareItemId: square_item_id,
      squareVariationId: square_variation_id,
    });
    mirrorWarning = ensured.warning;
    if (mirrorWarning) console.error("[recipe-square-links] catalog mirror not updated", mirrorWarning);
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
  // The link saved either way; `mirror_warning` says the backend cannot resolve
  // it yet, which is otherwise completely invisible from the grid.
  return NextResponse.json(mirrorWarning ? { ...data, mirror_warning: mirrorWarning } : data, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  try { await requirePermission(CAP.catalogOperate); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const { error } = await supabase.from("recipe_square_links").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
