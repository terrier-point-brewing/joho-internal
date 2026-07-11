import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchSquareInvoices, fetchInvoiceOrders, fetchSquareInvoiceById, fetchOrdersByIds } from "@/lib/square/orders";
import { fetchCatalogItems } from "@/lib/square/catalog";
import { mapSquareInvoiceStatus } from "@/lib/finance/invoiceStatus";
import type { CatalogItem, Order, SquareInvoice } from "@/types/square";
import {
  buildLineItemIndexes,
  buildInvoiceLineItemRows,
  persistInvoiceLineItems,
  invoiceHeaderTotalsFromOrder,
  resolveLineItemCoa,
  type LineItemCoa,
  type LineItemIndexes,
} from "./invoiceLineItems";

// Canonical home for these is ./invoiceLineItems; re-exported so existing
// importers (syncSquareInvoices.test.ts, callers) keep resolving them from here.
export { resolveLineItemCoa, type LineItemCoa };

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

/**
 * Precomputed indexes an invoice upsert needs, shared by the year + per-invoice
 * syncs. Extends the canonical line-item mapping indexes with the partner lookup
 * that only the invoice path needs.
 */
export interface InvoiceSyncContext extends LineItemIndexes {
  partnerByCustomerId: Map<string, string>;
}

/**
 * Build the partner + catalog + variation-deposit indexes an invoice upsert needs.
 * Shared so `syncSquareInvoicesForYear` (whole year) and `syncSquareInvoiceById`
 * (one invoice) classify + map line items identically — the line-item indexes come
 * from the same `buildLineItemIndexes` the generate read-backs use.
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

  const indexes = await buildLineItemIndexes(supabase, catalogItems);
  return { partnerByCustomerId, ...indexes };
}

/**
 * Upsert one Square invoice + its canonical line items. Header totals + per-line
 * money/identity/CoA all come from the shared mapper (`invoiceHeaderTotalsFromOrder`
 * + `buildInvoiceLineItemRows` + `persistInvoiceLineItems`), so the year sync, the
 * webhook single-invoice sync, and the export/deposit generate read-backs write an
 * identical shape. Fill-nulls-only on the CoA columns. Returns the outcome so
 * callers can aggregate counts (`error` = the invoice row failed to upsert;
 * line-item errors are collected but don't change the synced/updated outcome).
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

  const totals = invoiceHeaderTotalsFromOrder(order);
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
        subtotal_cents: totals.subtotal_cents,
        tax_cents:      totals.tax_cents,
        discount_cents: totals.discount_cents,
        total_cents:    totals.total_cents,
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

  // Load existing CoA mappings so a re-sync never wipes a manual/auto-mapped
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

  const rows = buildInvoiceLineItemRows(invRow.id, order, ctx, existingCoaBySort);
  const { error: liErr } = await persistInvoiceLineItems(supabase, invRow.id, rows);
  if (liErr) errors.push(`Line items for ${inv.invoice_number ?? inv.id}: ${liErr}`);

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
