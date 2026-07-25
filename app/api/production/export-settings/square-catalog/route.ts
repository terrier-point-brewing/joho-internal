import { NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { fetchCatalogItems, fetchCatalogDiscounts } from "@/lib/square/catalog";

export const dynamic = "force-dynamic";

export async function GET() {
  try { await requirePermission(CAP.productionSettingsRead); } catch (res) { return res as Response; }

  const [items, discounts] = await Promise.all([fetchCatalogItems(), fetchCatalogDiscounts()]);

  const itemOptions = items
    .filter((item) => !item.item_data.is_archived)
    .map((item) => ({
      itemId: item.id,
      itemName: item.item_data.name,
      variations: (item.item_data.variations ?? []).map((v) => ({
        variationId: v.id,
        variationName: v.item_variation_data.name,
        // Standalone catalog price so line-item pickers can auto-fill the unit
        // price the way Square's own invoice editor does.
        priceCents: v.item_variation_data.price_money?.amount ?? null,
      })),
    }));

  const discountOptions = discounts.map((d) => ({
    id: d.id,
    name: d.discount_data.name,
    // Expose type + value so callers (e.g. the invoice modal) can show and
    // estimate the discount amount, not just its name.
    discountType: d.discount_data.discount_type ?? null,
    percentage: d.discount_data.percentage ?? null,
    amountCents: d.discount_data.amount_money?.amount ?? null,
  }));

  return NextResponse.json({ items: itemOptions, discounts: discountOptions });
}
