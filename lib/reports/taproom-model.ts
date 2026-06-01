import type { CatalogItem, Order } from "@/types/square";
import type { TaproomModelResult, TaproomCategoryTotals } from "@/types/reports";
import type { SquareRefund } from "@/lib/square/refunds";
import { TAPROOM_MODEL_CATEGORIES, type TaproomCategoryId } from "@/lib/constants/categories";
import { detectCocktailSales } from "./cocktails";
import { buildKegIndex, detectKegSales } from "./kegs";
import { KEG_TRANSFER_DISCOUNT_NAME } from "@/types/reports";

// Build a reverse-lookup: Square category ID → Taproom Model category ID
function buildCategoryLookup(): Map<string, TaproomCategoryId> {
  const map = new Map<string, TaproomCategoryId>();
  for (const cat of TAPROOM_MODEL_CATEGORIES) {
    for (const sqId of cat.squareCats) {
      map.set(sqId, cat.id);
    }
  }
  return map;
}

function zeroCategoryTotals(): TaproomCategoryTotals {
  return { grossSalesCents: 0, discountsCents: 0, returnsCents: 0, taxCents: 0, netSalesCents: 0 };
}

function initByCategory(): Record<string, TaproomCategoryTotals> {
  const r: Record<string, TaproomCategoryTotals> = {};
  for (const cat of TAPROOM_MODEL_CATEGORIES) r[cat.id] = zeroCategoryTotals();
  return r;
}

function addToCategory(
  byCategory: Record<string, TaproomCategoryTotals>,
  catId: TaproomCategoryId,
  gross: number, discounts: number, tax: number
) {
  const t = byCategory[catId];
  if (!t) return;
  t.grossSalesCents  += gross;
  t.discountsCents   += discounts;
  t.taxCents         += tax;
  t.netSalesCents    = t.grossSalesCents - t.discountsCents - t.returnsCents;
}

export function buildTaproomModelReport(
  orders: Order[],
  items: CatalogItem[],
  refunds: SquareRefund[]
): TaproomModelResult {
  const categoryLookup = buildCategoryLookup();
  const byCategory = initByCategory();
  let totalTipsCents = 0;

  // ── 1. Cocktails (combo + non-combo) ────────────────────────────────────
  // Run unified cocktail detection, which returns:
  //   - aggregated CocktailSale[] with correct totals per cocktail
  //   - comboClaimedKeys: Set of "orderId:lineItemUid" for combo components
  const { sales: cocktailSales, comboClaimedKeys } = detectCocktailSales(orders, items);

  for (const cs of cocktailSales) {
    addToCategory(byCategory, "COCKTAILS", cs.grossSalesCents, cs.discountsCents, cs.taxCents);
  }

  // ── 2. Kegs (sales only — transfers excluded) ───────────────────────────
  const kegIndex = buildKegIndex(items);
  const kegSales = detectKegSales(orders, kegIndex);
  // Build claimed keys for keg line items so they aren't double-counted below
  const kegClaimedKeys = new Set(
    kegSales.map((ks) => `${ks.orderId}:${ks.rawLineItem.uid}`)
  );

  for (const ks of kegSales) {
    if (ks.isTransfer) continue; // exclude transfers from sales totals
    addToCategory(byCategory, "KEGS", ks.grossSalesCents, ks.discountsCents, ks.taxCents);
  }

  // ── 3. All other line items ──────────────────────────────────────────────
  // Build a set of non-combo cocktail variation IDs so we can skip those too
  // (they're already counted via cocktailSales above)
  const nonComboCocktailIds = new Set<string>();
  for (const item of items) {
    const catId = item.item_data.reporting_category?.id ?? "";
    if (item.item_data.product_type !== "COMBO") {
      // Check if any COCKTAILS category ID matches
      for (const sqId of [...byCategory["COCKTAILS"] ? [] : []]) { void sqId; }
    }
    // Simpler: mark non-combo cocktail variation IDs directly
    if (
      ["IPD6T7FOCCZBXG2HOPOVFB4J", "UE65PMYDYAA3GZVZZE2QXTEF"].includes(catId) &&
      item.item_data.product_type !== "COMBO"
    ) {
      for (const v of item.item_data.variations ?? []) nonComboCocktailIds.add(v.id);
    }
  }

  for (const order of orders) {
    totalTipsCents += order.total_tip_money?.amount ?? 0;

    for (const line of order.line_items ?? []) {
      const key   = `${order.id}:${line.uid}`;
      const varId = line.catalog_object_id ?? "";

      // Skip line items already claimed by cocktail or keg detection
      if (comboClaimedKeys.has(key)) continue;
      if (nonComboCocktailIds.has(varId)) continue; // non-combo cocktails already summed
      if (kegClaimedKeys.has(key)) continue;

      const reportingCatId = categoryLookup.get(
        // Try to find the category for this variation by looking it up in items
        // We use a simple approach: rely on reporting_category from catalog
        // The lookup is built from TAPROOM_MODEL_CATEGORIES squareCats arrays
        varId
      );

      // If we can't resolve via variation ID, we need to look up the item's category
      // Build a fallback from item reporting_category
      void reportingCatId; // resolved below via item lookup
    }
  }

  // The above approach won't work cleanly without a varId→category map.
  // Rebuild properly using the items catalog.
  const varIdToCategoryId = new Map<string, TaproomCategoryId>();
  for (const item of items) {
    const sqCatId = item.item_data.reporting_category?.id ?? "";
    const modelCatId = categoryLookup.get(sqCatId);
    if (!modelCatId) continue;
    for (const v of item.item_data.variations ?? []) {
      varIdToCategoryId.set(v.id, modelCatId);
    }
  }

  // Re-do the sweep properly
  // Reset only non-cocktail, non-keg categories (cocktails/kegs already done)
  const alreadyDone = new Set<TaproomCategoryId>(["COCKTAILS", "KEGS"]);
  for (const cat of TAPROOM_MODEL_CATEGORIES) {
    if (!alreadyDone.has(cat.id)) byCategory[cat.id] = zeroCategoryTotals();
  }

  for (const order of orders) {
    for (const line of order.line_items ?? []) {
      const key   = `${order.id}:${line.uid}`;
      const varId = line.catalog_object_id ?? "";

      if (comboClaimedKeys.has(key))         continue;
      if (nonComboCocktailIds.has(varId))    continue;
      if (kegClaimedKeys.has(key))           continue;

      // Gift cards have item_type="GIFT_CARD" and no catalog_object_id — bucket to Other
      const isGiftCard = line.item_type === "GIFT_CARD";
      const modelCatId = isGiftCard ? "OTHER" : varIdToCategoryId.get(varId);
      if (!modelCatId || alreadyDone.has(modelCatId)) continue;

      const gross     = line.gross_sales_money?.amount     ?? 0;
      const discounts = line.total_discount_money?.amount  ?? 0;
      const tax       = line.total_tax_money?.amount       ?? 0;
      addToCategory(byCategory, modelCatId, gross, discounts, tax);
    }
  }

  // ── 4. Returns — attribute refunds proportionally to order categories ────
  // Build a map of orderId → order for quick lookup
  const orderById = new Map(orders.map((o) => [o.id, o]));

  for (const refund of refunds) {
    const refundAmt = refund.amount_money.amount;
    const order     = orderById.get(refund.order_id);

    if (!order) {
      // Refunded order not in current fetch (outside date range or different state).
      // Cannot categorize — skip for now.
      continue;
    }

    // Compute total sales value of this order (excluding transfers) to use as denominator
    const orderLines = (order.line_items ?? []).filter((line) => {
      const discountNames = (line.applied_discounts ?? []).map(
        (ad) => (order.discounts ?? []).find((d) => d.uid === ad.discount_uid)?.name ?? ""
      );
      return !discountNames.includes(KEG_TRANSFER_DISCOUNT_NAME);
    });

    const orderTotal = orderLines.reduce(
      (s, li) => s + (li.gross_sales_money?.amount ?? 0),
      0
    );
    if (orderTotal === 0) continue;

    // Distribute the refund proportionally across the order's categories
    for (const line of orderLines) {
      const varId   = line.catalog_object_id ?? "";
      const lineAmt = line.gross_sales_money?.amount ?? 0;
      if (lineAmt === 0) continue;

      const lineKey = `${order.id}:${line.uid}`;
      let modelCatId: TaproomCategoryId | undefined;

      if (comboClaimedKeys.has(lineKey) || nonComboCocktailIds.has(varId)) {
        modelCatId = "COCKTAILS";
      } else if (kegClaimedKeys.has(lineKey)) {
        modelCatId = "KEGS";
      } else {
        modelCatId = varIdToCategoryId.get(varId);
      }

      if (!modelCatId) continue;

      const proportionalReturn = Math.round((lineAmt / orderTotal) * refundAmt);
      const t = byCategory[modelCatId];
      if (!t) continue;
      t.returnsCents  += proportionalReturn;
      t.netSalesCents  = t.grossSalesCents - t.discountsCents - t.returnsCents;
    }
  }

  return { byCategory, totalTipsCents };
}
