import type { CatalogItem, Order } from "@/types/square";
import type { TaproomModelResult, TaproomCategoryTotals } from "@/types/reports";
import type { SquareRefund } from "@/lib/square/refunds";
import { TAPROOM_MODEL_CATEGORIES, type TaproomCategoryId } from "@/lib/constants/categories";
import { detectCocktailSales, buildNonComboCocktailVariationIds } from "./cocktails";
import { buildKegIndex, detectKegSales } from "./kegs";
import { KEG_TRANSFER_DISCOUNT_NAME } from "@/types/reports";
import { memoizeByRef } from "@/lib/utils/memo";

// Build a reverse-lookup: Square category ID → Taproom Model category ID.
// Independent of orders/catalog, so compute it once at module load.
const CATEGORY_LOOKUP: Map<string, TaproomCategoryId> = (() => {
  const map = new Map<string, TaproomCategoryId>();
  for (const cat of TAPROOM_MODEL_CATEGORIES) {
    for (const sqId of cat.squareCats) {
      map.set(sqId, cat.id);
    }
  }
  return map;
})();

// variation_id → Taproom Model category, via each item's reporting_category.
// Memoized by item-array reference (rebuilt once per catalog, not per day).
const buildVarIdToCategoryId = memoizeByRef((items: CatalogItem[]): Map<string, TaproomCategoryId> => {
  const map = new Map<string, TaproomCategoryId>();
  for (const item of items) {
    const sqCatId = item.item_data.reporting_category?.id ?? "";
    const modelCatId = CATEGORY_LOOKUP.get(sqCatId);
    if (!modelCatId) continue;
    for (const v of item.item_data.variations ?? []) {
      map.set(v.id, modelCatId);
    }
  }
  return map;
});

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
  // Non-combo cocktails are already counted via cocktailSales above, so skip them.
  const nonComboCocktailIds = buildNonComboCocktailVariationIds(items);

  // variation_id → Taproom Model category, used to bucket remaining line items.
  const varIdToCategoryId = buildVarIdToCategoryId(items);

  // Cocktails and Kegs were already summed above; don't re-bucket them here.
  const alreadyDone = new Set<TaproomCategoryId>(["COCKTAILS", "KEGS"]);

  for (const order of orders) {
    totalTipsCents += order.total_tip_money?.amount ?? 0;

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
