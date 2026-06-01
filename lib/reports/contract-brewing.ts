import type { CatalogItem, Order } from "@/types/square";
import type { SquareCustomer } from "@/lib/square/customers";
import { customerDisplayName } from "@/lib/square/customers";
import {
  CATEGORY_IDS,
  CONTRACT_BREWING_SUBCATEGORY_LABELS,
  ContractBrewingSubcategory,
  classifyContractBrewingItem,
} from "@/lib/constants/categories";

export { CONTRACT_BREWING_SUBCATEGORY_LABELS };
export type { ContractBrewingSubcategory };

export interface ContractBrewingCategoryRow {
  subcategory: ContractBrewingSubcategory;
  label: string;
  grossCents: number;
  discountsCents: number;
  netCents: number;
}

export interface ContractBrewingCustomerRow {
  customerId: string;
  customerName: string;
  invoiceCount: number;
  totalChargedCents: number;    // sum of total_money
  totalOutstandingCents: number; // sum of net_amount_due_money
}

export interface ContractBrewingResult {
  byCategory: ContractBrewingCategoryRow[];
  byCustomer: ContractBrewingCustomerRow[];
}

export function buildContractBrewingReport(
  orders: Order[],
  items: CatalogItem[],
  customers: Map<string, SquareCustomer>
): ContractBrewingResult {
  // Build set of variation IDs in Contract Brewing category
  const cbVariationIds = new Set<string>();
  const varIdToItemName = new Map<string, string>();

  for (const item of items) {
    const rc = item.item_data.reporting_category?.id ?? "";
    if (!CATEGORY_IDS.CONTRACT_BREWING.has(rc)) continue;
    for (const v of item.item_data.variations ?? []) {
      cbVariationIds.add(v.id);
      varIdToItemName.set(v.id, item.item_data.name);
    }
  }

  // Initialise accumulators
  const catTotals: Record<ContractBrewingSubcategory, { gross: number; disc: number }> = {
    MATERIALS_PACKAGING: { gross: 0, disc: 0 },
    PACKAGING_FEES:      { gross: 0, disc: 0 },
    OTHER_SERVICES:      { gross: 0, disc: 0 },
    PASS_THROUGH_TAXES:  { gross: 0, disc: 0 },
  };

  const custTotals = new Map<
    string,
    { invoiceCount: number; charged: number; outstanding: number }
  >();

  for (const order of orders) {
    // Check this order has at least one contract brewing line item
    const hasContractItem = (order.line_items ?? []).some(
      (li) => li.catalog_object_id && cbVariationIds.has(li.catalog_object_id)
    );
    if (!hasContractItem) continue;

    // Customer totals
    const custId = order.customer_id ?? "unknown";
    const existing = custTotals.get(custId) ?? { invoiceCount: 0, charged: 0, outstanding: 0 };
    existing.invoiceCount += 1;
    existing.charged      += order.total_money?.amount ?? 0;
    existing.outstanding  += order.net_amount_due_money?.amount ?? 0;
    custTotals.set(custId, existing);

    // Category totals
    for (const line of order.line_items ?? []) {
      const varId = line.catalog_object_id ?? "";
      if (!cbVariationIds.has(varId)) continue;

      const itemName = varIdToItemName.get(varId) ?? line.name;
      const subcat   = classifyContractBrewingItem(itemName);
      const gross    = line.gross_sales_money?.amount    ?? 0;
      const disc     = line.total_discount_money?.amount ?? 0;

      catTotals[subcat].gross += gross;
      catTotals[subcat].disc  += disc;
    }
  }

  const subcatOrder: ContractBrewingSubcategory[] = [
    "MATERIALS_PACKAGING",
    "PACKAGING_FEES",
    "OTHER_SERVICES",
    "PASS_THROUGH_TAXES",
  ];

  const byCategory: ContractBrewingCategoryRow[] = subcatOrder.map((sc) => ({
    subcategory: sc,
    label:       CONTRACT_BREWING_SUBCATEGORY_LABELS[sc],
    grossCents:     catTotals[sc].gross,
    discountsCents: catTotals[sc].disc,
    netCents:       catTotals[sc].gross - catTotals[sc].disc,
  }));

  const byCustomer: ContractBrewingCustomerRow[] = Array.from(custTotals.entries())
    .sort((a, b) => b[1].charged - a[1].charged)
    .map(([custId, t]) => ({
      customerId:            custId,
      customerName:          customerDisplayName(customers.get(custId)),
      invoiceCount:          t.invoiceCount,
      totalChargedCents:     t.charged,
      totalOutstandingCents: t.outstanding,
    }));

  return { byCategory, byCustomer };
}
