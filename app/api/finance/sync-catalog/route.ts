import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { fetchCatalogItems, fetchCatalogCategories, fetchCatalogTaxes } from "@/lib/square/catalog";
import { volumeFlOzPerUnit, inferInventoryUnit } from "@/lib/square/catalogUnits";

export const dynamic = "force-dynamic";

export async function POST() {
  try { await requireRole([]); } catch (res) { return res as Response; }

  const [items, categories, taxes] = await Promise.all([
    fetchCatalogItems(),
    fetchCatalogCategories(),
    fetchCatalogTaxes(),
  ]);

  const categoryMap = new Map(categories.map((c) => [c.id, c.category_data]));
  const taxMap      = new Map(taxes.map((t) => [t.id, t.tax_data]));

  const now = new Date().toISOString();

  // ── Upsert items ─────────────────────────────────────────────────────────────
  const itemRows = items.map((item) => {
    const categoryId = item.item_data.reporting_category?.id ?? null;
    const taxIds     = item.item_data.tax_ids ?? [];
    const applicableTaxes = taxIds.flatMap((id) => {
      const t = taxMap.get(id);
      return t ? [{ id, name: t.name, percentage: t.percentage ?? null, inclusion_type: t.inclusion_type ?? null }] : [];
    });

    const catData        = categoryId ? (categoryMap.get(categoryId) ?? null) : null;
    const parentId       = catData?.parent_category?.id ?? null;
    const parentCatData  = parentId ? (categoryMap.get(parentId) ?? null) : null;

    return {
      square_item_id:        item.id,
      item_name:             item.item_data.name,
      description:           item.item_data.description ?? null,
      product_type:          item.item_data.product_type ?? null,
      category_id:           categoryId,
      category_name:         catData?.name ?? null,
      parent_category_id:    parentId,
      parent_category_name:  parentCatData?.name ?? null,
      is_top_level_category: catData?.is_top_level ?? null,
      tax_ids:               taxIds.length > 0 ? taxIds : null,
      applicable_taxes:      applicableTaxes.length > 0 ? applicableTaxes : null,
      is_archived:           item.item_data.is_archived ?? false,
      synced_at:             now,
    };
  });

  const supabase = createSupabaseAdminClient();

  const { data: upsertedItems, error: itemsError } = await supabase
    .from("square_catalog_items")
    .upsert(itemRows, { onConflict: "square_item_id" })
    .select("id, square_item_id");

  if (itemsError) return NextResponse.json({ error: itemsError.message }, { status: 500 });

  const itemIdMap = new Map((upsertedItems ?? []).map((r) => [r.square_item_id, r.id]));

  // ── Upsert variations ─────────────────────────────────────────────────────────
  const variationRows = items.flatMap((item) => {
    const catalogItemId = itemIdMap.get(item.id);
    if (!catalogItemId) return [];

    return (item.item_data.variations ?? []).map((v) => {
      const variationName = v.item_variation_data.name;
      return {
        square_variation_id:   v.id,
        catalog_item_id:       catalogItemId,
        square_item_id:        item.id,
        variation_name:        variationName,
        sku:                   v.item_variation_data.sku ?? null,
        upc:                   v.item_variation_data.upc ?? null,
        price_amount:          v.item_variation_data.price_money?.amount ?? null,
        price_currency:        v.item_variation_data.price_money?.currency ?? null,
        pricing_type:          v.item_variation_data.pricing_type ?? null,
        track_inventory:       v.item_variation_data.track_inventory ?? null,
        sellable:              v.item_variation_data.sellable ?? null,
        stockable:             v.item_variation_data.stockable ?? null,
        service_duration_ms:   v.item_variation_data.service_duration ?? null,
        inventory_unit:        inferInventoryUnit(variationName),
        volume_fl_oz_per_unit: volumeFlOzPerUnit(variationName),
        synced_at:             now,
      };
    });
  });

  const { data: upsertedVariations, error: varError } = await supabase
    .from("square_catalog_variations")
    .upsert(variationRows, { onConflict: "square_variation_id" })
    .select("id");

  if (varError) return NextResponse.json({ error: varError.message }, { status: 500 });

  // ── Backfill catalog_variation_id on recipe_square_links ──────────────────────
  // For any existing links that don't yet have a catalog_variation_id, resolve it
  // from the variation table by matching square_variation_id.
  // Fire-and-forget backfill; ignore errors
  void supabase.rpc("backfill_recipe_link_variation_ids");

  return NextResponse.json({
    items:      upsertedItems?.length ?? 0,
    variations: upsertedVariations?.length ?? 0,
  });
}
