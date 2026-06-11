/**
 * POST /api/finance/ledger/sync-square?year=YYYY
 *
 * Fetches Square invoices for the given year and upserts them into the ledger
 * (`invoices` + `invoice_line_items`). Idempotent: re-running updates existing
 * records via the (source, external_id) unique constraint.
 *
 * Also attempts to match each invoice's Square customer_id to
 * contract_brewing_partners.square_customer_id so partner_id is populated
 * automatically where possible.
 *
 * Line items are classified using the same logic as /api/finance/sales/invoices.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { fetchSquareInvoices, fetchInvoiceOrders } from "@/lib/square/orders";
import { fetchCatalogItems } from "@/lib/square/catalog";
import { buildKegIndex } from "@/lib/reports/kegs";
import { canOzPerUnit } from "@/lib/reports/bbl-tracker";
import { CATEGORY_IDS } from "@/lib/constants/categories";
import { classifyLineItem } from "@/lib/finance/classify";
import type { CatalogItem, Order, SquareInvoice } from "@/types/square";
import type { InvoiceStatus, InvoiceLineCategory } from "@/types/finance";

export const dynamic = "force-dynamic";

function squareStatusToLedger(status: string): InvoiceStatus {
  switch (status.toUpperCase()) {
    case "PAID":                         return "paid";
    case "DRAFT":                        return "draft";
    case "UNPAID": case "SCHEDULED":     return "open";
    case "PARTIALLY_PAID":               return "partial";
    case "CANCELED": case "REFUNDED":    return "voided";
    default:                             return "unknown";
  }
}

function recipientName(inv: SquareInvoice): string {
  const r = inv.primary_recipient;
  if (!r) return "Unknown";
  if (r.company_name) return r.company_name;
  const parts = [r.given_name, r.family_name].filter(Boolean);
  return parts.length ? parts.join(" ") : "Unknown";
}

// ── Route ─────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try { await requireRole("admin"); } catch (res) { return res as Response; }

  const year    = parseInt(req.nextUrl.searchParams.get("year") ?? String(new Date().getFullYear()));
  const supabase = createSupabaseAdminClient();

  try {

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
  // The Square Invoices API does not support date-range filtering, so we fetch
  // all invoices and discard those outside the requested year.
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
    return NextResponse.json({ synced: 0, updated: 0, skipped: 0, total: 0 });
  }

  // ── 3. Build catalog indexes (for keg/can line item classification) ───────
  const kegIndex = buildKegIndex(catalogItems);

  const canVariationOz = new Map<string, number>();
  for (const item of catalogItems) {
    if (!CATEGORY_IDS.CANS.has(item.item_data.reporting_category?.id ?? "")) continue;
    for (const v of item.item_data.variations ?? []) {
      canVariationOz.set(v.id, canOzPerUnit(v.item_variation_data.name));
    }
  }

  // Index orders by their Square order ID for O(1) lookup
  const orderById = new Map<string, Order>(orders.map((o) => [o.id, o]));

  // ── 4. Upsert each invoice ────────────────────────────────────────────────
  let synced  = 0;
  let updated = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const inv of squareInvoices) {
    const order = orderById.get(inv.order_id);
    if (!order) {
      // Invoice exists in Square but order wasn't returned by our date-range
      // query (e.g. created just outside the window). Skip rather than error.
      skipped++;
      continue;
    }

    const customerId = inv.primary_recipient?.customer_id ?? null;
    const partnerId  = customerId ? (partnerByCustomerId.get(customerId) ?? null) : null;
    const dueDate    = inv.payment_requests?.[0]?.due_date ?? null;

    // Total from the order (authoritative)
    const totalCents = order.total_money?.amount ?? 0;
    const taxCents   = order.total_tax_money?.amount ?? 0;
    const subtotal   = totalCents - taxCents;

    // Map Square invoice status to our enum
    const status = squareStatusToLedger(inv.status);

    // Snapshot of the Square invoice object for auditability
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
          source:         "square",
          external_id:    inv.id,
          invoice_number: inv.invoice_number ?? inv.id,
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

    // ── Classify and upsert line items ──────────────────────────────────────
    // Use upsert on (invoice_id, sort_order) to avoid the delete-then-insert
    // window where a concurrent read would see zero line items.

    const lineItems: {
      invoice_id: string; sort_order: number; description: string;
      category: InvoiceLineCategory | null; quantity: number;
      unit_price_cents: number; total_cents: number;
      variation_name: string | null; raw_data: Record<string, string | number>;
    }[] = [];

    // BET carve-out detection (same logic as sales route)
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

      // Distribution: catalog keg items
      const keg = kegIndex.get(varId);
      if (keg) category = "distribution_keg";

      // Distribution: catalog can items
      if (!category && canVariationOz.has(varId)) category = "distribution_can";

      // BET with carve-out → skip (nets to zero)
      if (!category && li.name.toLowerCase().includes("barrel excise tax")) {
        const idx = carveOutAmounts.findIndex((a) => Math.abs(a - gross) <= 1);
        if (idx >= 0) { carveOutAmounts.splice(idx, 1); return; }
      }

      // CB / service items
      if (!category) category = classifyLineItem(li.name);

      lineItems.push({
        invoice_id:       invRow.id,
        sort_order:       i,
        description:      li.name + (varName ? ` — ${varName}` : ""),
        category,
        quantity:         qty,
        unit_price_cents: li.base_price_money?.amount ?? 0,
        total_cents:      li.total_money?.amount ?? 0,
        variation_name:   varName || null,
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
      // Remove any stale line items at positions beyond the new count (e.g. order was edited to fewer items).
      if (!liErr && lineItems.length > 0) {
        await supabase
          .from("invoice_line_items")
          .delete()
          .eq("invoice_id", invRow.id)
          .gt("sort_order", lineItems.length - 1);
      }
    }
  }

  return NextResponse.json({
    year,
    synced,
    updated,
    skipped,
    total: squareInvoices.length,
    errors: errors.length ? errors : undefined,
  }, { status: errors.length && synced + updated === 0 ? 500 : 200 });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[sync-square]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
