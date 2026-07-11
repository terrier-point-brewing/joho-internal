import type { SupabaseClient } from "@supabase/supabase-js";
export { resolveLineItemCoa, type LineItemCoa } from "./invoiceLineItems";
import { buildLineItemIndexes, buildInvoiceLineItemRows, persistInvoiceLineItems, type LineItemCoa } from "./invoiceLineItems";
import { fetchSquareInvoices, fetchInvoiceOrders } from "@/lib/square/orders";
import { fetchCatalogItems } from "@/lib/square/catalog";
import { mapSquareInvoiceStatus } from "@/lib/finance/invoiceStatus";
import type { CatalogItem, Order, SquareInvoice } from "@/types/square";

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

export async function syncSquareInvoicesForYear(
  supabase: SupabaseClient,
  year: number
): Promise<SyncSquareInvoicesResult> {
  // ── 1. Load partners (for customer_id → partner_id matching) ─────────────
  const { data: partners } = await supabase
    .from("contract_brewing_partners")
    .select("id, square_customer_id")
    .not("square_customer_id", "is", null);

  const partnerByCustomerId = new Map<string, string>(
    (partners ?? [])
      .filter((p): p is { id: string; square_customer_id: string } => !!p.square_customer_id)
      .map((p) => [p.square_customer_id, p.id])
  );

  // ── 2. Fetch Square invoices (all locations) then filter by year ──────────
  const startDate = `${year}-01-01`;
  const endDate   = `${year}-12-31`;

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

  // ── 3. Build catalog indexes (for keg/can line item classification) ───────
  const indexes = await buildLineItemIndexes(supabase, catalogItems);

  const orderById = new Map<string, Order>(orders.map((o) => [o.id, o]));

  // ── 5. Upsert each invoice ────────────────────────────────────────────────
  let synced  = 0;
  let updated = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const inv of squareInvoices) {
    const order = orderById.get(inv.order_id);
    if (!order) { skipped++; continue; }

    const customerId = inv.primary_recipient?.customer_id ?? null;
    const partnerId  = customerId ? (partnerByCustomerId.get(customerId) ?? null) : null;
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
      errors.push(`Invoice ${inv.invoice_number ?? inv.id}: ${invErr?.message ?? "unknown error"}`);
      continue;
    }

    const wasInserted = invRow.created_at === invRow.updated_at;
    if (wasInserted) synced++; else updated++;

    // Load existing COA mappings so a re-sync never wipes a manual/auto-mapped
    // account — the upsert below would otherwise overwrite these columns.
    const { data: existingLines } = await supabase
      .from("invoice_line_items")
      .select("sort_order, chart_of_accounts_id, bs_chart_of_accounts_id, pl_chart_of_accounts_id")
      .eq("invoice_id", invRow.id);
    const existingCoaBySort = new Map<number, LineItemCoa>(
      (existingLines ?? []).map((r) => [r.sort_order as number, {
        chart_of_accounts_id: r.chart_of_accounts_id,
        bs_chart_of_accounts_id: r.bs_chart_of_accounts_id,
        pl_chart_of_accounts_id: r.pl_chart_of_accounts_id,
      }]),
    );

    const rows = buildInvoiceLineItemRows(invRow.id, order, indexes, existingCoaBySort);
    const { error: liErr } = await persistInvoiceLineItems(supabase, invRow.id, rows);
    if (liErr) errors.push(`Line items for ${inv.invoice_number ?? inv.id}: ${liErr}`);
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
