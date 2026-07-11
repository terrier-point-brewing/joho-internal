import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchSquareInvoices, fetchInvoiceOrders, fetchSquareInvoiceById, fetchOrdersByIds } from "@/lib/square/orders";
import { fetchCatalogItems } from "@/lib/square/catalog";
import { buildKegIndex } from "@/lib/reports/kegs";
import { canOzPerUnit } from "@/lib/reports/bbl-tracker";
import { CATEGORY_IDS } from "@/lib/constants/categories";
import { classifyLineItem } from "@/lib/finance/classify";
import { mapSquareInvoiceStatus } from "@/lib/finance/invoiceStatus";
import type { CatalogItem, Order, SquareInvoice } from "@/types/square";
import type { InvoiceLineCategory } from "@/types/finance";

export interface LineItemCoa {
  chart_of_accounts_id: string | null;
  bs_chart_of_accounts_id: string | null;
  pl_chart_of_accounts_id: string | null;
}

/**
 * Chart-of-accounts values to write for a line item on (re-)sync. An existing
 * non-null mapping (user-set or auto-mapped) always wins; the variation prefill
 * only fills gaps. This makes re-syncs non-destructive — matching the app's
 * fill-nulls-only mapping convention (invoices/auto-map, expenses/auto-map).
 */
export function resolveLineItemCoa(existing: LineItemCoa | undefined, prefill: LineItemCoa): LineItemCoa {
  return {
    chart_of_accounts_id:    existing?.chart_of_accounts_id    ?? prefill.chart_of_accounts_id,
    bs_chart_of_accounts_id: existing?.bs_chart_of_accounts_id ?? prefill.bs_chart_of_accounts_id,
    pl_chart_of_accounts_id: existing?.pl_chart_of_accounts_id ?? prefill.pl_chart_of_accounts_id,
  };
}

function recipientName(inv: SquareInvoice): string {
  const r = inv.primary_recipient;
  if (!r) return "Unknown";
  if (r.company_name) return r.company_name;
  const parts = [r.given_name, r.family_name].filter(Boolean);
  return parts.length ? parts.join(" ") : "Unknown";
}

export interface SyncSquareInvoicesResult {
  year: number;
  synced: number;
  updated: number;
  skipped: number;
  total: number;
  errors?: string[];
}

/** Precomputed indexes an invoice upsert needs, shared by the year + per-invoice syncs. */
export interface InvoiceSyncContext {
  partnerByCustomerId: Map<string, string>;
  kegIndex: ReturnType<typeof buildKegIndex>;
  canVariationOz: Map<string, number>;
  variationById: Map<string, {
    chart_of_accounts_id_invoice: string | null;
    bs_chart_of_accounts_id: string | null;
    pl_chart_of_accounts_id: string | null;
  }>;
}

/**
 * Build the partner + catalog + variation-deposit indexes an invoice upsert needs.
 * Shared so `syncSquareInvoicesForYear` (whole year) and `syncSquareInvoiceById`
 * (one invoice) classify + map line items identically.
 */
export async function buildInvoiceSyncContext(
  supabase: SupabaseClient,
  catalogItems: CatalogItem[],
): Promise<InvoiceSyncContext> {
  // Partners (for customer_id → partner_id matching).
  const { data: partners } = await supabase
    .from("contract_brewing_partners")
    .select("id, square_customer_id")
    .not("square_customer_id", "is", null);

  const partnerByCustomerId = new Map<string, string>(
    (partners ?? [])
      .filter((p): p is { id: string; square_customer_id: string } => !!p.square_customer_id)
      .map((p) => [p.square_customer_id, p.id])
  );

  // Catalog indexes (for keg/can line item classification).
  const kegIndex = buildKegIndex(catalogItems);

  const canVariationOz = new Map<string, number>();
  for (const item of catalogItems) {
    if (!CATEGORY_IDS.CANS.has(item.item_data.reporting_category?.id ?? "")) continue;
    for (const v of item.item_data.variations ?? []) {
      canVariationOz.set(v.id, canOzPerUnit(v.item_variation_data.name));
    }
  }

  // Variation deposit mappings (BS/PL).
  const { data: variationMappings } = await supabase
    .from("square_catalog_variations")
    .select("square_variation_id, chart_of_accounts_id_invoice, bs_chart_of_accounts_id, pl_chart_of_accounts_id")
    .or("bs_chart_of_accounts_id.not.is.null,pl_chart_of_accounts_id.not.is.null,chart_of_accounts_id_invoice.not.is.null");

  const variationById = new Map<string, {
    chart_of_accounts_id_invoice: string | null;
    bs_chart_of_accounts_id: string | null;
    pl_chart_of_accounts_id: string | null;
  }>(
    (variationMappings ?? []).map((v) => [v.square_variation_id, v])
  );

  return { partnerByCustomerId, kegIndex, canVariationOz, variationById };
}

/**
 * Upsert one Square invoice + its line items (fill-nulls-only on the CoA columns,
 * carve-out excise skip, trailing-line delete). Returns the outcome so callers can
 * aggregate counts. `skipped` = no matching order; `error` = the invoice row failed
 * to upsert (line-item errors are collected but don't change the synced/updated
 * outcome, matching the original per-invoice behavior).
 */
async function upsertInvoiceWithLines(
  supabase: SupabaseClient,
  inv: SquareInvoice,
  order: Order,
  ctx: InvoiceSyncContext,
): Promise<{ outcome: "synced" | "updated" | "skipped" | "error"; errors?: string[] }> {
  const customerId = inv.primary_recipient?.customer_id ?? null;
  const partnerId  = customerId ? (ctx.partnerByCustomerId.get(customerId) ?? null) : null;
  const dueDate    = inv.payment_requests?.[0]?.due_date ?? null;

  const totalCents = order.total_money?.amount ?? 0;
  const taxCents   = order.total_tax_money?.amount ?? 0;
  const subtotal   = totalCents - taxCents;

  const status = mapSquareInvoiceStatus(inv.status);

  const rawData = {
    square_invoice_id: inv.id,
    square_order_id:   inv.order_id,
    square_status:     inv.status,
    created_at:        inv.created_at,
    updated_at:        inv.updated_at ?? inv.created_at,
  };

  const { data: invRow, error: invErr } = await supabase
    .from("invoices")
    .upsert(
      {
        source:            "square",
        external_id:       inv.id,
        square_invoice_id: inv.id,
        invoice_number:    inv.invoice_number ?? null,
        invoice_date:   inv.created_at.slice(0, 10),
        due_date:       dueDate,
        customer_name:  recipientName(inv),
        partner_id:     partnerId,
        status,
        subtotal_cents: subtotal,
        tax_cents:      taxCents,
        total_cents:    totalCents,
        notes:          inv.title ?? null,
        raw_data:       rawData,
      },
      { onConflict: "source,external_id", ignoreDuplicates: false }
    )
    .select("id, created_at, updated_at")
    .single();

  if (invErr || !invRow) {
    return { outcome: "error", errors: [`Invoice ${inv.invoice_number ?? inv.id}: ${invErr?.message ?? "unknown error"}`] };
  }

  const wasInserted = invRow.created_at === invRow.updated_at;
  const errors: string[] = [];

  const lineItems: {
    invoice_id: string; sort_order: number; description: string;
    category: InvoiceLineCategory | null; quantity: number;
    unit_price_cents: number; total_cents: number;
    variation_name: string | null; raw_data: Record<string, string | number>;
    chart_of_accounts_id?: string | null;
    bs_chart_of_accounts_id?: string | null;
    pl_chart_of_accounts_id?: string | null;
  }[] = [];

  // Load existing COA mappings so a re-sync never wipes a manual/auto-mapped
  // account — the upsert below would otherwise overwrite these columns.
  const { data: existingLines } = await supabase
    .from("invoice_line_items")
    .select("sort_order, chart_of_accounts_id, bs_chart_of_accounts_id, pl_chart_of_accounts_id")
    .eq("invoice_id", invRow.id);
  const existingCoaBySort = new Map<number, LineItemCoa>(
    (existingLines ?? []).map((r) => [
      r.sort_order as number,
      {
        chart_of_accounts_id:    r.chart_of_accounts_id,
        bs_chart_of_accounts_id: r.bs_chart_of_accounts_id,
        pl_chart_of_accounts_id: r.pl_chart_of_accounts_id,
      },
    ]),
  );

  const carveOutAmounts = (order.discounts ?? [])
    .filter((d) => d.name.toLowerCase().includes("carve out"))
    .map((d) => d.applied_money?.amount ?? 0)
    .filter((a) => a > 0);

  (order.line_items ?? []).forEach((li, i) => {
    const qty       = parseFloat(li.quantity ?? "1");
    const gross     = li.gross_sales_money?.amount ?? 0;
    const varId     = li.catalog_object_id ?? "";
    const varName   = li.variation_name ?? "";

    let category: InvoiceLineCategory | null = null;

    const keg = ctx.kegIndex.get(varId);
    if (keg) category = "distribution_keg";

    if (!category && ctx.canVariationOz.has(varId)) category = "distribution_can";

    if (!category && li.name.toLowerCase().includes("barrel excise tax")) {
      const idx = carveOutAmounts.findIndex((a) => Math.abs(a - gross) <= 1);
      if (idx >= 0) { carveOutAmounts.splice(idx, 1); return; }
    }

    if (!category) category = classifyLineItem(li.name);

    const varMapping = varId ? ctx.variationById.get(varId) : undefined;
    const coa = resolveLineItemCoa(existingCoaBySort.get(i), {
      chart_of_accounts_id:    varMapping?.chart_of_accounts_id_invoice ?? null,
      bs_chart_of_accounts_id: varMapping?.bs_chart_of_accounts_id ?? null,
      pl_chart_of_accounts_id: varMapping?.pl_chart_of_accounts_id ?? null,
    });
    lineItems.push({
      invoice_id:              invRow.id,
      sort_order:              i,
      description:             li.name + (varName ? ` — ${varName}` : ""),
      category,
      quantity:                qty,
      unit_price_cents:        li.base_price_money?.amount ?? 0,
      total_cents:             li.total_money?.amount ?? 0,
      variation_name:          varName || null,
      chart_of_accounts_id:    coa.chart_of_accounts_id,
      bs_chart_of_accounts_id: coa.bs_chart_of_accounts_id,
      pl_chart_of_accounts_id: coa.pl_chart_of_accounts_id,
      raw_data: {
        uid:       li.uid,
        name:      li.name,
        var_name:  varName,
        gross:     gross,
        discount:  li.total_discount_money?.amount ?? 0,
      },
    });
  });

  if (lineItems.length) {
    const { error: liErr } = await supabase
      .from("invoice_line_items")
      .upsert(lineItems, { onConflict: "invoice_id,sort_order", ignoreDuplicates: false });
    if (liErr) errors.push(`Line items for ${inv.invoice_number ?? inv.id}: ${liErr.message}`);
    if (!liErr && lineItems.length > 0) {
      await supabase
        .from("invoice_line_items")
        .delete()
        .eq("invoice_id", invRow.id)
        .gt("sort_order", lineItems.length - 1);
    }
  }

  return { outcome: wasInserted ? "synced" : "updated", errors: errors.length ? errors : undefined };
}

export async function syncSquareInvoicesForYear(
  supabase: SupabaseClient,
  year: number
): Promise<SyncSquareInvoicesResult> {
  const startDate = `${year}-01-01`;
  const endDate   = `${year}-12-31`;

  // Fetch Square invoices (all locations) then filter by year, plus the year's
  // orders and the catalog for classification.
  const [allSquareInvoices, orders, catalogItems] = await Promise.all([
    fetchSquareInvoices(),
    fetchInvoiceOrders(startDate, endDate),
    fetchCatalogItems() as Promise<CatalogItem[]>,
  ]);

  const squareInvoices = allSquareInvoices.filter((inv) => {
    const date = (inv.created_at ?? "").slice(0, 10);
    return date >= startDate && date <= endDate;
  });

  if (squareInvoices.length === 0) {
    return { year, synced: 0, updated: 0, skipped: 0, total: 0 };
  }

  const ctx = await buildInvoiceSyncContext(supabase, catalogItems);
  const orderById = new Map<string, Order>(orders.map((o) => [o.id, o]));

  let synced  = 0;
  let updated = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const inv of squareInvoices) {
    const order = orderById.get(inv.order_id);
    if (!order) { skipped++; continue; }

    const res = await upsertInvoiceWithLines(supabase, inv, order, ctx);
    if (res.outcome === "synced") synced++;
    else if (res.outcome === "updated") updated++;
    if (res.errors) errors.push(...res.errors);
  }

  return {
    year,
    synced,
    updated,
    skipped,
    total: squareInvoices.length,
    errors: errors.length ? errors : undefined,
  };
}

/**
 * Sync a single Square invoice by id — the near-real-time path for the invoice
 * webhook, so a delivery doesn't re-pull every invoice + a year of orders. Fetches
 * just this invoice + its order + the catalog, then upserts it (idempotent,
 * fill-nulls-only). Returns `not_found` when Square has no such invoice and
 * `skipped` when its order can't be retrieved.
 */
export async function syncSquareInvoiceById(
  supabase: SupabaseClient,
  squareInvoiceId: string,
): Promise<{ found: boolean; outcome: "synced" | "updated" | "skipped" | "error" | "not_found"; error?: string }> {
  const inv = await fetchSquareInvoiceById(squareInvoiceId);
  if (!inv) return { found: false, outcome: "not_found" };

  const [orders, catalogItems] = await Promise.all([
    inv.order_id ? fetchOrdersByIds([inv.order_id]) : Promise.resolve([] as Order[]),
    fetchCatalogItems() as Promise<CatalogItem[]>,
  ]);
  const order = orders[0];
  if (!order) return { found: true, outcome: "skipped" };

  const ctx = await buildInvoiceSyncContext(supabase, catalogItems);
  const res = await upsertInvoiceWithLines(supabase, inv, order, ctx);
  return { found: true, outcome: res.outcome, error: res.errors?.[0] };
}
