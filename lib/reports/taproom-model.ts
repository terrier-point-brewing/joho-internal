import type { CatalogItem, Order, OrderLineItem } from "@/types/square";
import type {
  TaproomModelResult,
  TaproomCategoryTotals,
  TaproomLineContribution,
} from "@/types/reports";
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

// Where a contribution came from. Required — not optional — on both funnels
// below, so a category total can never be moved without also saying which line
// moved it. That is what keeps the Sales Pulse drill-down honest as new
// categories and detection rules get added.
interface LineContext {
  orderId: string;
  lineUid: string;
  occurredAt: string;
  itemName: string;
  variationName: string;
  quantity: number;
  discountNames: string[];
  prorated?: boolean;
}

// Names of the order-level discounts applied to a line. `applied_discounts`
// only carries uids; the human-readable name lives on `order.discounts`.
function discountNamesFor(order: Order, line: OrderLineItem): string[] {
  return (line.applied_discounts ?? [])
    .map((ad) => (order.discounts ?? []).find((d) => d.uid === ad.discount_uid)?.name ?? "")
    .filter(Boolean);
}

function addToCategory(
  byCategory: Record<string, TaproomCategoryTotals>,
  contributions: TaproomLineContribution[],
  catId: TaproomCategoryId,
  gross: number, discounts: number, tax: number,
  ctx: LineContext
) {
  const t = byCategory[catId];
  if (!t) return;
  t.grossSalesCents  += gross;
  t.discountsCents   += discounts;
  t.taxCents         += tax;
  t.netSalesCents    = t.grossSalesCents - t.discountsCents - t.returnsCents;

  contributions.push({
    categoryId: catId,
    orderId: ctx.orderId,
    lineUid: ctx.lineUid,
    occurredAt: ctx.occurredAt,
    itemName: ctx.itemName,
    variationName: ctx.variationName,
    quantity: ctx.quantity,
    grossSalesCents: gross,
    discountsCents: discounts,
    returnsCents: 0,
    taxCents: tax,
    discountNames: ctx.discountNames,
    kind: "sale",
    prorated: ctx.prorated ?? false,
  });
}

export function buildTaproomModelReport(
  orders: Order[],
  items: CatalogItem[],
  refunds: SquareRefund[]
): TaproomModelResult {
  const byCategory = initByCategory();
  const contributions: TaproomLineContribution[] = [];
  let totalTipsCents = 0;

  // ── 1. Cocktails (combo + non-combo) ────────────────────────────────────
  // Run unified cocktail detection, which returns:
  //   - aggregated CocktailSale[] with correct totals per cocktail
  //   - comboClaimedKeys: Set of "orderId:lineItemUid" for combo components
  const { sales: cocktailSales, comboClaimedKeys } = detectCocktailSales(orders, items);

  for (const cs of cocktailSales) {
    addToCategory(
      byCategory, contributions, "COCKTAILS",
      cs.grossSalesCents, cs.discountsCents, cs.taxCents,
      {
        orderId: cs.orderId,
        // A combo is one sale assembled from N component lines; join their uids
        // so the drill row still points back at every line it covers.
        lineUid: cs.rawLineItems.map((li) => li.uid).join("+"),
        occurredAt: cs.rawOrder.created_at ?? cs.orderClosedAt,
        itemName: cs.itemName,
        variationName: cs.variationName,
        quantity: cs.quantity,
        discountNames: cs.rawLineItems.flatMap((li) => discountNamesFor(cs.rawOrder, li)),
      }
    );
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
    addToCategory(
      byCategory, contributions, "KEGS",
      ks.grossSalesCents, ks.discountsCents, ks.taxCents,
      {
        orderId: ks.orderId,
        lineUid: ks.rawLineItem.uid,
        occurredAt: ks.rawOrder.created_at ?? ks.orderClosedAt,
        itemName: ks.beerName,
        variationName: ks.kegSize,
        quantity: ks.quantity,
        discountNames: ks.discountNames,
      }
    );
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
      addToCategory(
        byCategory, contributions, modelCatId, gross, discounts, tax,
        {
          orderId: order.id,
          lineUid: line.uid,
          occurredAt: order.created_at ?? order.closed_at ?? "",
          itemName: line.name,
          variationName: line.variation_name ?? "",
          quantity: Number(line.quantity ?? "1") || 0,
          discountNames: discountNamesFor(order, line),
        }
      );
    }
  }

  // ── 4. Returns ───────────────────────────────────────────────────────────
  // Build a map of orderId → order for quick lookup
  const orderById = new Map(orders.map((o) => [o.id, o]));

  // Resolve a line to its model category, honouring the cocktail/keg claims
  // established above (those two categories are detected, not looked up).
  const categoryForLine = (
    orderId: string,
    lineUid: string | undefined,
    varId: string
  ): TaproomCategoryId | undefined => {
    const key = `${orderId}:${lineUid ?? ""}`;
    if (comboClaimedKeys.has(key) || nonComboCocktailIds.has(varId)) return "COCKTAILS";
    if (kegClaimedKeys.has(key)) return "KEGS";
    return varIdToCategoryId.get(varId);
  };

  const addReturn = (catId: TaproomCategoryId, cents: number, ctx: LineContext) => {
    const t = byCategory[catId];
    if (!t) return;
    t.returnsCents  += cents;
    t.netSalesCents  = t.grossSalesCents - t.discountsCents - t.returnsCents;

    contributions.push({
      categoryId: catId,
      orderId: ctx.orderId,
      lineUid: ctx.lineUid,
      occurredAt: ctx.occurredAt,
      itemName: ctx.itemName,
      variationName: ctx.variationName,
      quantity: ctx.quantity,
      grossSalesCents: 0,
      discountsCents: 0,
      returnsCents: cents,
      taxCents: 0,
      discountNames: ctx.discountNames,
      kind: "return",
      prorated: ctx.prorated ?? false,
    });
  };

  // A refund's `order_id` points at the *return order* Square creates for it —
  // a separate, negative-total order that carries no `line_items` at all. Its
  // `returns[].return_line_items` are the actual goods, and they repeat the
  // catalog id and money, so each returned line is attributed to its own
  // category exactly rather than pro-rated across the sale.
  //
  // Guard against two refunds resolving to the same return order, which would
  // otherwise book its lines twice.
  const countedReturnOrderIds = new Set<string>();

  for (const refund of refunds) {
    const refundAmt = refund.amount_money.amount;
    const order     = orderById.get(refund.order_id);

    if (!order) {
      // Refunded order not in current fetch (outside date range or different state).
      // Cannot categorize — skip for now.
      continue;
    }

    const returnLines = (order.returns ?? []).flatMap((r) =>
      (r.return_line_items ?? []).map((li) => ({ ...li, sourceOrderId: r.source_order_id ?? "" }))
    );

    if (returnLines.length > 0) {
      if (countedReturnOrderIds.has(order.id)) continue;
      countedReturnOrderIds.add(order.id);

      for (const rli of returnLines) {
        const varId = rli.catalog_object_id ?? "";
        const catId = categoryForLine(rli.sourceOrderId, rli.source_line_item_uid, varId);
        if (!catId) continue;

        // Book the return net of any discount the original line carried, so it
        // reverses exactly what the sale contributed (gross − discounts). Tax is
        // excluded: `returnsCents` is compared against ex-tax gross.
        const gross    = rli.gross_return_money?.amount   ?? 0;
        const discount = rli.total_discount_money?.amount ?? 0;
        addReturn(catId, gross - discount, {
          orderId: rli.sourceOrderId || order.id,
          lineUid: rli.source_line_item_uid ?? rli.uid,
          occurredAt: order.created_at ?? order.closed_at ?? "",
          itemName: rli.name,
          variationName: rli.variation_name ?? "",
          quantity: Number(rli.quantity ?? "1") || 0,
          discountNames: [],
        });
      }
      continue;
    }

    // A return order with no returned lines is a tip-only refund (Square puts
    // these in `returns[].return_tips`). Tips were never in gross sales, so
    // there is nothing to reverse.
    if ((order.returns ?? []).length > 0) continue;

    // Fallback for refunds that point directly at the sale order rather than a
    // return order: no per-line detail, so pro-rate across the order's
    // categories by gross.
    //
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

      const modelCatId = categoryForLine(order.id, line.uid, varId);
      if (!modelCatId) continue;

      addReturn(modelCatId, Math.round((lineAmt / orderTotal) * refundAmt), {
        orderId: order.id,
        lineUid: line.uid,
        occurredAt: order.created_at ?? order.closed_at ?? "",
        itemName: line.name,
        variationName: line.variation_name ?? "",
        quantity: Number(line.quantity ?? "1") || 0,
        discountNames: discountNamesFor(order, line),
        // Share of a refund that carried no per-line detail — see the note on
        // TaproomLineContribution.prorated.
        prorated: true,
      });
    }
  }

  return { byCategory, totalTipsCents, contributions };
}
