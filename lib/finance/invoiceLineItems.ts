import type { SupabaseClient } from "@supabase/supabase-js";
import type { CatalogItem, Order } from "@/types/square";
import type { InvoiceLineCategory } from "@/types/finance";
import { buildKegIndex } from "@/lib/reports/kegs";
import { canOzPerUnit } from "@/lib/reports/bbl-tracker";
import { CATEGORY_IDS } from "@/lib/constants/categories";
import { classifyLineItem } from "@/lib/finance/classify";
import { buildLineItemTaxRows } from "@/lib/finance/lineItemTaxRows";

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
  /**
   * The line's label, as two atoms. Callers that need a display string compose
   * `line_item_name — variation_name`; there is deliberately no stored copy of
   * that composition, because one existed until 2026-08 and had already gone
   * stale against renamed catalog items.
   */
  line_item_name: string | null;
  variation_name: string | null;
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
   * Square's per-line uid. MUST be written here rather than left to another
   * writer: persistInvoiceLineItems upserts on (invoice_id, sort_order), so a
   * column absent from this type is never overwritten. syncPosTransactions.ts
   * used to write invoice lines itself, numbering them from 1 across every
   * order line, and its uids survived underneath this builder's 0-based,
   * excise-skipping sort_order -- corrupting 60 of 64 populated uids. That
   * second writer is gone (it also destroyed hand-set accounts, which is why),
   * but the column stays here: correct by construction beats correct by
   * agreement between two files.
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

/**
 * Total of the order's ORDER-scope (invoice-level) discounts, in cents.
 *
 * The single definition of "invoice-level discount" — `buildInvoiceLineItemRows`
 * writes it as a line and `invoiceHeaderTotalsFromOrder` writes it to the header,
 * and those two must never disagree or the lines stop summing to the total.
 */
export function orderScopedDiscountTotal(order: Order): number {
  return (order.discounts ?? [])
    .filter((d) => (d.scope ?? "").toUpperCase() === "ORDER")
    .reduce((s, d) => s + (d.applied_money?.amount ?? 0), 0);
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

  // Square allocates an ORDER-scope discount pro-rata into every line's
  // `total_discount_money`, which is NOT how a flat invoice-level discount
  // behaves: it isn't a property of any one line, and letting it erode a
  // pass-through excise line understates a tax we still remit in full. So a
  // line only absorbs the LINE_ITEM-scope discounts actually applied to it;
  // the invoice-level remainder becomes its own line below.
  const lineScopedDiscountUids = new Set(
    (order.discounts ?? [])
      .filter((d) => (d.scope ?? "").toUpperCase() !== "ORDER")
      .map((d) => d.uid),
  );
  const lineScopedDiscountFor = (li: { applied_discounts?: { discount_uid: string; applied_money?: { amount?: number } }[] }) =>
    (li.applied_discounts ?? [])
      .filter((ad) => lineScopedDiscountUids.has(ad.discount_uid))
      .reduce((sum, ad) => sum + (ad.applied_money?.amount ?? 0), 0);

  // Same filter `invoiceHeaderTotalsFromOrder` uses for `discount_cents`, so the
  // discount line below always equals the header's discount figure.
  const orderScopedDiscountCents = orderScopedDiscountTotal(order);

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
    // No order-level discount on this order → `total_discount_money` is already
    // line-scoped money, so use it directly and stay bit-identical to the old
    // behaviour (it also survives orders that predate `applied_discounts`).
    const discount = orderScopedDiscountCents === 0
      ? (li.total_discount_money?.amount ?? 0)
      : lineScopedDiscountFor(li);
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

  // The invoice-level discount, as its own trailing line. Written UNMAPPED
  // (no chart_of_accounts_id) so it surfaces in the Financials "Unmapped"
  // data-quality bucket and a human assigns the contra-revenue account in
  // Finance > Transactions > Invoices — the same path every other unmapped
  // line takes. `resolveLineItemCoa` still runs so a mapping, once set by
  // hand, survives every later re-sync.
  if (orderScopedDiscountCents > 0) {
    const coa = resolveLineItemCoa(existingCoaBySort.get(sortOrder), { chart_of_accounts_id: null });
    const names = (order.discounts ?? [])
      .filter((d) => (d.scope ?? "").toUpperCase() === "ORDER")
      .map((d) => d.name)
      .filter(Boolean);
    const label = names.length === 1 ? names[0] : "Invoice Discount";
    rows.push({
      invoice_id: invoiceId,
      sort_order: sortOrder,
      line_item_name: label,
      variation_name: null,
      note: null,
      category: "discount",
      quantity: 1,
      // Negative money throughout: this line REDUCES the invoice, and every
      // consumer that sums line rows has to see that without special-casing.
      unit_price_cents: -orderScopedDiscountCents,
      gross_sales_cents: -orderScopedDiscountCents,
      discount_cents: 0,
      net_sales_cents: -orderScopedDiscountCents,
      tax_cents: 0,
      total_cents: -orderScopedDiscountCents,
      square_catalog_variation_id: null,
      // Not a Square line item — it has no uid to key taxes off.
      square_line_item_uid: null,
      chart_of_accounts_id: coa.chart_of_accounts_id,
    });
  }

  return rows;
}

export function invoiceHeaderTotalsFromOrder(order: Order) {
  const total = order.total_money?.amount ?? 0;
  const tax   = order.total_tax_money?.amount ?? 0;
  const orderDiscount = orderScopedDiscountTotal(order);
  const subtotal = total - tax + orderDiscount;
  return { subtotal_cents: subtotal, tax_cents: tax, discount_cents: orderDiscount, total_cents: total };
}

/**
 * Rebuilds an invoice's `invoice_line_item_taxes` rows from `order`, keyed off
 * the invoice's just-upserted `invoice_line_items` rows (read back by
 * `square_line_item_uid`, which this builder writes by construction -- see
 * `CanonicalLineItemRow.square_line_item_uid`'s docstring). Always deletes
 * first, even when the invoice no longer has any taxable lines, so a
 * since-removed tax doesn't survive as a stale row.
 */
async function rebuildInvoiceLineItemTaxes(
  supabase: SupabaseClient,
  invoiceId: string,
  order: Order,
): Promise<{ error?: string }> {
  const { data: lineRows, error: selectError } = await supabase
    .from("invoice_line_items")
    .select("id, square_line_item_uid")
    .eq("invoice_id", invoiceId);
  if (selectError) return { error: selectError.message };

  const uidMap = new Map<string, string>();
  const lineIds: string[] = [];
  for (const row of (lineRows ?? []) as { id: string; square_line_item_uid: string | null }[]) {
    lineIds.push(row.id);
    if (row.square_line_item_uid) uidMap.set(row.square_line_item_uid, row.id);
  }

  if (lineIds.length > 0) {
    const { error: deleteError } = await supabase
      .from("invoice_line_item_taxes")
      .delete()
      .in("line_item_id", lineIds);
    if (deleteError) return { error: deleteError.message };
  }

  const taxRows = buildLineItemTaxRows(order, uidMap);
  if (taxRows.length > 0) {
    const { error: insertError } = await supabase.from("invoice_line_item_taxes").insert(taxRows);
    if (insertError) return { error: insertError.message };
  }

  return {};
}

export async function persistInvoiceLineItems(
  supabase: SupabaseClient,
  invoiceId: string,
  rows: CanonicalLineItemRow[],
  order?: Order,
): Promise<{ error?: string }> {
  if (rows.length === 0) {
    await supabase.from("invoice_line_items").delete().eq("invoice_id", invoiceId);
    return {};
  }
  const { error } = await supabase
    .from("invoice_line_items")
    .upsert(rows, { onConflict: "invoice_id,sort_order", ignoreDuplicates: false });
  if (error) return { error: error.message };
  const { error: deleteError } = await supabase
    .from("invoice_line_items")
    .delete()
    .eq("invoice_id", invoiceId)
    .gt("sort_order", rows.length - 1);
  if (deleteError) return { error: deleteError.message };

  if (order) {
    const taxResult = await rebuildInvoiceLineItemTaxes(supabase, invoiceId, order);
    if (taxResult.error) return taxResult;
  }

  return {};
}
