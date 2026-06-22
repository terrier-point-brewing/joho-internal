import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { fetchCatalogItems, fetchCatalogDiscounts } from "@/lib/square/catalog";

export const dynamic = "force-dynamic";

export async function GET() {
  try { await requireRole(["viewer", "brewer", "manager"]); } catch (res) { return res as Response; }

  const [items, discounts] = await Promise.all([fetchCatalogItems(), fetchCatalogDiscounts()]);

  const itemOptions = items
    .filter((item) => !item.item_data.is_archived)
    .map((item) => ({
      itemId: item.id,
      itemName: item.item_data.name,
      variations: (item.item_data.variations ?? []).map((v) => ({
        variationId: v.id,
        variationName: v.item_variation_data.name,
      })),
    }));

  const discountOptions = discounts.map((d) => ({ id: d.id, name: d.discount_data.name }));

  return NextResponse.json({ items: itemOptions, discounts: discountOptions });
}
