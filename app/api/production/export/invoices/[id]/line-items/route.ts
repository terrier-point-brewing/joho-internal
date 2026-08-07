import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { cancelInvoice, createExportInvoice } from "@/lib/square/square-invoices";
import { fetchOrdersByIds } from "@/lib/square/orders";
import { fetchCatalogItems } from "@/lib/square/catalog";
import {
  buildLineItemIndexes,
  buildInvoiceLineItemRows,
  persistInvoiceLineItems,
  invoiceHeaderTotalsFromOrder,
  type LineItemCoa,
} from "@/lib/finance/invoiceLineItems";
import type { CatalogItem } from "@/types/square";
import { getNetTermsDays } from "@/lib/production/invoiceTerms";
import { addDaysStr, todayLocalDate } from "@/lib/utils/datetime";

export const dynamic = "force-dynamic";

/**
 * `note` is the text that shows as the line item's note on the Square invoice
 * (e.g. "Packaging Fee — Epic Hazy IPA"). For catalog-backed lines the visible
 * name comes from Square's catalog, so the note is the only free-text field.
 * For custom (non-catalog) lines Square has no note and it becomes the name.
 */
interface AddBody {
  action: "add";
  note: string;
  quantity: number;
  unit_price_cents: number;
  square_catalog_variation_id?: string | null;
}

interface RemoveBody {
  action: "remove";
  line_item_id: string;
}

interface EditBody {
  action: "edit";
  line_item_id: string;
  note?: string;
  quantity?: number;
  unit_price_cents?: number;
}

type PatchBody = AddBody | RemoveBody | EditBody;

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try { await requirePermission(CAP.exportOperate); } catch (res) { return res as Response; }

  const { id: invoiceId } = await params;

  let body: PatchBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!["add", "remove", "edit"].includes(body.action)) {
    return NextResponse.json({ error: "action must be add, remove, or edit" }, { status: 400 });
  }

  const supabase = createSupabaseAdminClient();

  // Load invoice — must be draft and have a Square ID.
  const { data: inv, error: invErr } = await supabase
    .from("invoices")
    .select("id, status, square_invoice_id, partner_id, total_cents")
    .eq("id", invoiceId)
    .single();
  if (invErr || !inv) {
    return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  }
  if (inv.status !== "draft") {
    return NextResponse.json({ error: "Line items can only be edited on Draft invoices" }, { status: 422 });
  }
  if (!inv.square_invoice_id) {
    return NextResponse.json({ error: "Invoice has no linked Square draft" }, { status: 422 });
  }

  // Load partner for Square customer ID + net terms.
  const { data: partner, error: partnerErr } = await supabase
    .from("contract_brewing_partners")
    .select("company_name, square_customer_id")
    .eq("id", inv.partner_id)
    .single();
  if (partnerErr || !partner?.square_customer_id) {
    return NextResponse.json({ error: "Partner not found or missing Square customer" }, { status: 400 });
  }

  // Editing line items recreates the Square draft, so the due date re-derives
  // from today (a redraft resets the clock).
  const netTerms = await getNetTermsDays(supabase, "export");
  const draftDate = todayLocalDate();
  const dueDate = addDaysStr(draftDate, netTerms);

  // Load current line items.
  const { data: currentItems, error: itemsErr } = await supabase
    .from("invoice_line_items")
    .select("id, sort_order, note, quantity, unit_price_cents, total_cents, square_catalog_variation_id, chart_of_accounts_id")
    .eq("invoice_id", invoiceId)
    .order("sort_order");
  if (itemsErr) return NextResponse.json({ error: itemsErr.message }, { status: 500 });

  // Build updated items list.
  type StoredItem = {
    id: string; sort_order: number; note: string | null;
    quantity: number; unit_price_cents: number; total_cents: number;
    square_catalog_variation_id: string | null; chart_of_accounts_id?: string | null;
  };

  let updatedItems: StoredItem[] = currentItems ?? [];

  if (body.action === "add") {
    if (body.quantity <= 0 || body.unit_price_cents < 0 || isNaN(body.quantity) || isNaN(body.unit_price_cents)) {
      return NextResponse.json({ error: "quantity must be a positive number and unit_price_cents must be non-negative" }, { status: 400 });
    }
    const newItem: StoredItem = {
      id: crypto.randomUUID(),
      sort_order: updatedItems.length,
      // The canonical read-back below fills in catalog identity; this value only
      // survives as-is if that read-back fails.
      note: body.note,
      quantity: body.quantity,
      unit_price_cents: body.unit_price_cents,
      total_cents: body.quantity * body.unit_price_cents,
      square_catalog_variation_id: body.square_catalog_variation_id ?? null,
    };
    updatedItems = [...updatedItems, newItem];
  } else if (body.action === "edit") {
    const target = updatedItems.find((item) => item.id === body.line_item_id);
    if (!target) {
      return NextResponse.json({ error: "Line item not found" }, { status: 404 });
    }
    const nextQty = body.quantity ?? target.quantity;
    const nextPrice = body.unit_price_cents ?? target.unit_price_cents;
    if (nextQty <= 0 || nextPrice < 0 || isNaN(nextQty) || isNaN(nextPrice)) {
      return NextResponse.json({ error: "quantity must be a positive number and unit_price_cents must be non-negative" }, { status: 400 });
    }
    updatedItems = updatedItems.map((item) =>
      item.id === body.line_item_id
        ? {
            ...item,
            note: body.note ?? item.note,
            quantity: nextQty,
            unit_price_cents: nextPrice,
            total_cents: nextQty * nextPrice,
          }
        : item
    );
  } else {
    updatedItems = updatedItems.filter((item) => item.id !== body.line_item_id);
    if (updatedItems.length === (currentItems ?? []).length) {
      return NextResponse.json({ error: "Line item not found" }, { status: 404 });
    }
  }

  if (updatedItems.length === 0) {
    return NextResponse.json({ error: "Invoice must have at least one line item" }, { status: 422 });
  }

  // Cancel the existing Square draft and recreate with updated items.
  try {
    await cancelInvoice(inv.square_invoice_id as string);
  } catch (err) {
    console.error("[line-items] cancelInvoice failed:", err);
    return NextResponse.json({ error: "Failed to cancel existing Square draft" }, { status: 500 });
  }

  // `description` here is the Square draft's field, not a column: it becomes the
  // Square line's note (catalog lines) or its name (custom lines). The stored
  // `note` is the only free text we hold, so it is what we send.
  const lineItemsForSquare = updatedItems.map((item) => ({
    id: item.id,
    description: item.note ?? "",
    quantity: item.quantity,
    unitPriceCents: item.unit_price_cents,
    squareCatalogVariationId: item.square_catalog_variation_id,
  }));

  let newSquareResult;
  try {
    newSquareResult = await createExportInvoice({
      squareCustomerId: partner.square_customer_id,
      title: `Export Invoice — ${partner.company_name}`,
      lineItems: lineItemsForSquare,
      dueDate,
    });
  } catch (err) {
    // The old Square draft was already cancelled. Clear square_invoice_id so the UI
    // shows this as a broken draft that needs to be regenerated.
    await supabase
      .from("invoices")
      .update({ square_invoice_id: null, external_id: null })
      .eq("id", invoiceId);
    const message = err instanceof Error ? err.message : "Square invoice recreation failed";
    return NextResponse.json(
      { error: `Square draft was cancelled but recreation failed — re-generate the invoice. Details: ${message}` },
      { status: 500 }
    );
  }

  // Update local invoice: new Square ID + new total.
  const newTotal = updatedItems.reduce((s, i) => s + i.total_cents, 0);
  const { error: invUpdateErr } = await supabase
    .from("invoices")
    .update({
      square_invoice_id: newSquareResult.invoiceId,
      external_id: newSquareResult.invoiceId,
      subtotal_cents: newTotal,
      total_cents: newTotal,
      invoice_date: draftDate,
      due_date: dueDate,
    })
    .eq("id", invoiceId);
  if (invUpdateErr) return NextResponse.json({ error: invUpdateErr.message }, { status: 500 });

  // Re-persist line items from the recreated Square order, through the same
  // mapper the sync and the generate read-back use. That's what splits the
  // catalog identity (`line_item_name`/`variation_name`) from the line's note
  // (`note`) and classifies `category` — a hand-rolled insert flattens both.
  let linesPersisted = false;
  try {
    const [orders, catalogItems] = await Promise.all([
      fetchOrdersByIds([newSquareResult.orderId]),
      fetchCatalogItems(),
    ]);
    const order = orders[0];
    if (!order) throw new Error(`order read-back returned no order for ${newSquareResult.orderId}`);
    const indexes = await buildLineItemIndexes(supabase, catalogItems as CatalogItem[]);

    // Carry existing CoA mappings across the rebuild. Keyed by variation rather
    // than sort_order because add/remove shifts every position after it.
    const coaByVariation = new Map<string, string>();
    for (const item of currentItems ?? []) {
      if (item.square_catalog_variation_id && item.chart_of_accounts_id) {
        coaByVariation.set(item.square_catalog_variation_id, item.chart_of_accounts_id);
      }
    }
    const existingCoaBySort = new Map<number, LineItemCoa>();
    (order.line_items ?? []).forEach((li, i) => {
      const coa = li.catalog_object_id ? coaByVariation.get(li.catalog_object_id) : undefined;
      if (coa) existingCoaBySort.set(i, { chart_of_accounts_id: coa });
    });

    const rows = buildInvoiceLineItemRows(invoiceId, order, indexes, existingCoaBySort);
    const { error: persistErr } = await persistInvoiceLineItems(supabase, invoiceId, rows, order);
    if (persistErr) throw new Error(persistErr);
    linesPersisted = true;

    const totals = invoiceHeaderTotalsFromOrder(order);
    const { error: hdrErr } = await supabase.from("invoices").update(totals).eq("id", invoiceId);
    if (hdrErr) console.error("[line-items] header totals update failed:", hdrErr.message);
  } catch (err) {
    console.error("[line-items] read-back failed, falling back to draft values:", err);
  }

  if (!linesPersisted) {
    // Fallback: persist the draft values so the invoice is never left empty; a
    // later sync reconciles catalog identity, notes, and categories.
    const { error: deleteErr } = await supabase.from("invoice_line_items").delete().eq("invoice_id", invoiceId);
    if (deleteErr) return NextResponse.json({ error: deleteErr.message }, { status: 500 });
    const { error: insertErr } = await supabase.from("invoice_line_items").insert(
      updatedItems.map((item, i) => ({
        invoice_id: invoiceId,
        sort_order: i,
        note: item.note,
        category: "other_services",
        quantity: item.quantity,
        unit_price_cents: item.unit_price_cents,
        total_cents: item.total_cents,
        square_catalog_variation_id: item.square_catalog_variation_id,
        chart_of_accounts_id: item.chart_of_accounts_id ?? null,
      }))
    );
    if (insertErr) return NextResponse.json({ error: insertErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
