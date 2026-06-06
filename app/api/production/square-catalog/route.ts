import { NextResponse } from "next/server";
import { fetchCatalogItems } from "@/lib/square/catalog";
import { apiError } from "@/lib/utils/api";

// Flattened list of catalog item variations, for linking recipes to Square inventory.
export async function GET() {
  try {
    const items = await fetchCatalogItems();
    const variations = items.flatMap((item) =>
      (item.item_data.variations ?? []).map((v) => ({
        variation_id: v.id,
        item_id: item.id,
        item_name: item.item_data.name,
        variation_name: v.item_variation_data.name,
        reporting_category_id: item.item_data.reporting_category?.id ?? null,
      })),
    );
    return NextResponse.json(variations);
  } catch (err) {
    return apiError(err);
  }
}
