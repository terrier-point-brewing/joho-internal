import { NextResponse } from "next/server";
import { fetchCatalogItems } from "@/lib/square/catalog";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";

export const dynamic = "force-dynamic";

// Flattened list of catalog item variations for linking recipes to Square inventory.
// category_name is joined from the master square_catalog_items table when available.
export async function GET() {
  try {
    const [items, masterRows] = await Promise.all([
      fetchCatalogItems(),
      createSupabaseAdminClient()
        .from("square_catalog_items")
        .select("square_item_id, category_id, category_name")
        .then(({ data }) => data ?? []),
    ]);

    const masterMap = new Map(masterRows.map((r) => [r.square_item_id, r]));

    const variations = items.flatMap((item) => {
      const master = masterMap.get(item.id);
      return (item.item_data.variations ?? []).map((v) => ({
        variation_id:          v.id,
        item_id:               item.id,
        item_name:             item.item_data.name,
        variation_name:        v.item_variation_data.name,
        reporting_category_id: master?.category_id ?? item.item_data.reporting_category?.id ?? null,
        category_name:         master?.category_name ?? null,
      }));
    });

    return NextResponse.json(variations);
  } catch (err) {
    return apiError(err);
  }
}
