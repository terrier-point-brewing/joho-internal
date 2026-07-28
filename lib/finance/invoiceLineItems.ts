import type { SupabaseClient } from "@supabase/supabase-js";
import type { CatalogItem, Order } from "@/types/square";
import type { InvoiceLineCategory } from "@/types/finance";
import { buildKegIndex } from "@/lib/reports/kegs";
import { canOzPerUnit } from "@/lib/reports/bbl-tracker";
import { CATEGORY_IDS } from "@/lib/constants/categories";
import { classifyLineItem } from "@/lib/finance/classify";

export interface LineItemCoa {
  chart_of_accounts_id: string | null;
}

/**
 * Fill-nulls-only COA resolution: an existing non-null mapping always wins;
 * the variation prefill only fills gaps. Keeps re-syncs non-destructive.
 */
export function resolveLineItemCoa(existing: LineItemCoa | undefined, prefill: LineItemCoa): LineItemCoa {
  return {
    chart_of_accounts_id: existing?.chart_of_accounts_id ?? prefill.chart_of_accounts_id,
  };
}

export interface LineItemIndexes {
  kegIndex: ReturnType<typeof buildKegIndex>;
  canVariationOz: Map<string, number>;
  variationById: Map<string, {
    chart_of_accounts_id_invoice: string | null;
    chart_of_accounts_id: string | null;
  }>;
  itemNameByVariationId: Map<string, string>;
}

export interface CanonicalLineItemRow {
  invoice_id: string;
  sort_order: number;
  line_item_name: string | null;
  variation_name: string | null;
  description: string;
  note: string | null;
  category: InvoiceLineCategory | null;
  quantity: number;
  unit_price_cents: number;
  gross_sales_cents: number;
  discount_cents: number;
  net_sales_cents: number;
  tax_cents: number;
  total_cents: number;
  square_catalog_variation_id: string | null;
  /**
   * Square's per-line uid. MUST be written here rather than left to
   * syncPosTransactions.ts's buildInvoiceLineItems: persistInvoiceLineItems
   * upserts on (invoice_id, sort_order), so a column absent from this type is
   * never overwritten. That let a 1-based uid from the other writer survive
   * under this builder's 0-based, excise-skipping sort_order -- corrupting 60
   * of 64 populated uids before this fix.
   */
  square_line_item_uid: string | null;
  chart_of_accounts_id: string | null;
}

export async function buildLineItemIndexes(
  supabase: SupabaseClient,
  catalogItems: CatalogItem[],
): Promise<LineItemIndexes> {
  const kegIndex = buildKegIndex(catalogItems);

  const canVariationOz = new Map<string, number>();
  const itemNameByVariationId = new Map<string, string>();
  for (const item of catalogItems) {
    const isCan = CATEGORY_IDS.CANS.has(item.item_data.reporting_category?.id ?? "");
    for (const v of item.item_data.variations ?? []) {
      itemNameByVariationId.set(v.id, item.item_data.name);
      if (isCan) canVariationOz.set(v.id, canOzPerUnit(v.item_variation_data.name));
    }
  }

  const { data: variationMappings } = await supabase
    .from("square_catalog_variations")
    .select("square_variation_id, chart_of_accounts_id_invoice, chart_of_accounts_id")
    .or("chart_of_accounts_id_invoice.not.is.null,chart_of_accounts_id.not.is.null");

  const variationById = new Map(
    (variationMappings ?? []).map((v) => [v.square_variation_id, {
      chart_of_accounts_id_invoice: v.chart_of_accounts_id_invoice,
      chart_of_accounts_id: v.chart_of_accounts_id,
    }]),
  );

  return { kegIndex, canVariationOz, variationById, itemNameByVariationId };
}

export function buildInvoiceLineItemRows(
  invoiceId: string,
  order: Order,
  indexes: LineItemIndexes,
  existingCoaBySort: Map<number, LineItemCoa>,
): CanonicalLineItemRow[] {
  const { kegIndex, canVariationOz, variationById, itemNameByVariationId } = indexes;

  const carveOutAmounts = (order.discounts ?? [])
    .filter((d) => d.name.toLowerCase().includes("carve out"))
    .map((d) => d.applied_money?.amount ?? 0)
    .filter((a) => a > 0);

  const rows: CanonicalLineItemRow[] = [];
  // sort_order counts PUSHED rows, not the order's line-item positions: carve-out
  // excise lines are skipped below, and a gap would make persistInvoiceLineItems'
  // `sort_order > rows.length - 1` cleanup delete a row it just wrote. Keyed the
  // same way, existingCoaBySort stays aligned — its keys are DB sort_order values
  // this function wrote, so they are push positions too.
  let sortOrder = 0;
  (order.line_items ?? []).forEach((li) => {
    const qty     = parseFloat(li.quantity ?? "1");
    const varId   = li.catalog_object_id ?? "";
    const varName = li.variation_name ?? "";
    const gross   = li.gross_sales_money?.amount ?? 0;
    const discount = li.total_discount_money?.amount ?? 0;
    const tax      = li.total_tax_money?.amount ?? 0;

    let category: InvoiceLineCategory | null = null;
    if (kegIndex.get(varId)) category = "distribution_keg";
    if (!category && canVariationOz.has(varId)) category = "distribution_can";
    if (!category && li.name.toLowerCase().includes("barrel excise tax")) {
      const idx = carveOutAmounts.findIndex((a) => Math.abs(a - gross) <= 1);
      if (idx >= 0) { carveOutAmounts.splice(idx, 1); return; }
    }
    if (!category) category = classifyLineItem(li.name);

    const varMapping = varId ? variationById.get(varId) : undefined;
    const coa = resolveLineItemCoa(existingCoaBySort.get(sortOrder), {
      // Invoice-specific override wins; else the variation's default GL. Matches
      // the invoice auto-map priority so a re-sync fully maps in one pass.
      chart_of_accounts_id: varMapping?.chart_of_accounts_id_invoice ?? varMapping?.chart_of_accounts_id ?? null,
    });

    const lineName = varId ? (itemNameByVariationId.get(varId) ?? li.name) : li.name;
    const net = gross - discount;

    rows.push({
      invoice_id: invoiceId,
      sort_order: sortOrder,
      line_item_name: lineName || null,
      variation_name: varName || null,
      description: li.name + (varName ? ` — ${varName}` : ""),
      note: li.note ?? null,
      category,
      quantity: qty,
      unit_price_cents: li.base_price_money?.amount ?? 0,
      gross_sales_cents: gross,
      discount_cents: discount,
      net_sales_cents: net,
      tax_cents: tax,
      total_cents: net,
      square_catalog_variation_id: varId || null,
      square_line_item_uid: li.uid ?? null,
      chart_of_accounts_id: coa.chart_of_accounts_id,
    });
    sortOrder++;
  });

  return rows;
}

export function invoiceHeaderTotalsFromOrder(order: Order) {
  const total = order.total_money?.amount ?? 0;
  const tax   = order.total_tax_money?.amount ?? 0;
  const orderDiscount = (order.discounts ?? [])
    .filter((d) => (d.scope ?? "").toUpperCase() === "ORDER")
    .reduce((s, d) => s + (d.applied_money?.amount ?? 0), 0);
  const subtotal = total - tax + orderDiscount;
  return { subtotal_cents: subtotal, tax_cents: tax, discount_cents: orderDiscount, total_cents: total };
}

export async function persistInvoiceLineItems(
  supabase: SupabaseClient,
  invoiceId: string,
  rows: CanonicalLineItemRow[],
): Promise<{ error?: string }> {
  if (rows.length === 0) {
    await supabase.from("invoice_line_items").delete().eq("invoice_id", invoiceId);
    return {};
  }
  const { error } = await supabase
    .from("invoice_line_items")
    .upsert(rows, { onConflict: "invoice_id,sort_order", ignoreDuplicates: false });
  if (error) return { error: error.message };
  await supabase
    .from("invoice_line_items")
    .delete()
    .eq("invoice_id", invoiceId)
    .gt("sort_order", rows.length - 1);
  return {};
}
