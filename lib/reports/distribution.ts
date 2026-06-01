import type { CatalogItem, Order } from "@/types/square";
import type { SquareCustomer } from "@/lib/square/customers";
import { CATEGORY_IDS } from "@/lib/constants/categories";

const KEG_SIZE_PATTERN = /^\d+\/\d+ Keg$/;

export type DistributionSize = "1/2 Keg" | "1/6 Keg" | "1/4 Keg" | "Cans" | "Other";

export interface DistributionSizeRow {
  size: DistributionSize;
  qty: number;
  grossCents: number;
  discountsCents: number;
  netCents: number;
}

export interface DistributionCustomerRow {
  customerId: string;
  customerName: string;
  invoiceCount: number;
  totalChargedCents: number;
  totalOutstandingCents: number;
  halfKegQty: number;
  sixthKegQty: number;
  quarterKegQty: number;
  cansQty: number;
}

export interface DistributionResult {
  bySize: DistributionSizeRow[];
  byCustomer: DistributionCustomerRow[];
}

interface VarInfo { beerName: string; size: DistributionSize; isCan: boolean }

export function buildDistributionReport(
  orders: Order[],
  items: CatalogItem[],
  customers: Map<string, SquareCustomer>
): DistributionResult {
  // Build variation lookup for keg and can items
  const varInfo = new Map<string, VarInfo>();

  for (const item of items) {
    const rc = item.item_data.reporting_category?.id ?? "";
    const isKeg = CATEGORY_IDS.KEGS.has(rc);
    const isCan = CATEGORY_IDS.CANS.has(rc);
    if (!isKeg && !isCan) continue;

    const beerName = item.item_data.name.replace(/ \(Keg\)$/i, "").replace(/ \(Cans?\)$/i, "");

    for (const v of item.item_data.variations ?? []) {
      const vname = v.item_variation_data.name;
      // Skip deposits (variation name doesn't match keg sizes)
      if (isKeg && !KEG_SIZE_PATTERN.test(vname)) continue;

      let size: DistributionSize = "Other";
      if (isCan)                   size = "Cans";
      else if (vname === "1/2 Keg") size = "1/2 Keg";
      else if (vname === "1/6 Keg") size = "1/6 Keg";
      else if (vname === "1/4 Keg") size = "1/4 Keg";

      varInfo.set(v.id, { beerName, size, isCan });
    }
  }

  // Accumulators
  const sizeTotals = new Map<DistributionSize, { qty: number; gross: number; disc: number }>();
  const custTotals = new Map<
    string,
    { invoiceCount: number; charged: number; outstanding: number; halfKeg: number; sixthKeg: number; quarterKeg: number; cans: number }
  >();

  for (const order of orders) {
    const hasDistItem = (order.line_items ?? []).some(
      (li) => li.catalog_object_id && varInfo.has(li.catalog_object_id)
    );
    if (!hasDistItem) continue;

    const custId = order.customer_id ?? "unknown";
    const cust = custTotals.get(custId) ?? {
      invoiceCount: 0, charged: 0, outstanding: 0,
      halfKeg: 0, sixthKeg: 0, quarterKeg: 0, cans: 0,
    };
    cust.invoiceCount += 1;
    cust.charged      += order.total_money?.amount ?? 0;
    cust.outstanding  += order.net_amount_due_money?.amount ?? 0;

    for (const line of order.line_items ?? []) {
      const varId = line.catalog_object_id ?? "";
      const info  = varInfo.get(varId);
      if (!info) continue;

      const qty   = parseInt(line.quantity ?? "1", 10);
      const gross = line.gross_sales_money?.amount    ?? 0;
      const disc  = line.total_discount_money?.amount ?? 0;

      const st = sizeTotals.get(info.size) ?? { qty: 0, gross: 0, disc: 0 };
      st.qty   += qty;
      st.gross += gross;
      st.disc  += disc;
      sizeTotals.set(info.size, st);

      if (info.size === "1/2 Keg") cust.halfKeg    += qty;
      if (info.size === "1/6 Keg") cust.sixthKeg   += qty;
      if (info.size === "1/4 Keg") cust.quarterKeg += qty;
      if (info.size === "Cans")    cust.cans        += qty;
    }

    custTotals.set(custId, cust);
  }

  const sizeOrder: DistributionSize[] = ["1/2 Keg", "1/4 Keg", "1/6 Keg", "Cans", "Other"];
  const bySize: DistributionSizeRow[] = sizeOrder
    .map((size) => {
      const t = sizeTotals.get(size) ?? { qty: 0, gross: 0, disc: 0 };
      return { size, qty: t.qty, grossCents: t.gross, discountsCents: t.disc, netCents: t.gross - t.disc };
    })
    .filter((r) => r.qty > 0);

  const { customerDisplayName } = require("@/lib/square/customers");

  const byCustomer: DistributionCustomerRow[] = Array.from(custTotals.entries())
    .sort((a, b) => b[1].charged - a[1].charged)
    .map(([custId, t]) => ({
      customerId:            custId,
      customerName:          customerDisplayName(customers.get(custId)),
      invoiceCount:          t.invoiceCount,
      totalChargedCents:     t.charged,
      totalOutstandingCents: t.outstanding,
      halfKegQty:            t.halfKeg,
      sixthKegQty:           t.sixthKeg,
      quarterKegQty:         t.quarterKeg,
      cansQty:               t.cans,
    }));

  return { bySize, byCustomer };
}
