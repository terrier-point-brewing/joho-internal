import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { cancelInvoice, createExportInvoice } from "@/lib/square/square-invoices";

export const dynamic = "force-dynamic";

interface AddBody {
  action: "add";
  description: string;
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
  description?: string;
  quantity?: number;
  unit_price_cents?: number;
}

type PatchBody = AddBody | RemoveBody | EditBody;

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try { await requireRole(["brewer"]); } catch (res) { return res as Response; }

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
    .select("company_name, square_customer_id, export_net_terms_days")
    .eq("id", inv.partner_id)
    .single();
  if (partnerErr || !partner?.square_customer_id) {
    return NextResponse.json({ error: "Partner not found or missing Square customer" }, { status: 400 });
  }

  let dueDays = partner.export_net_terms_days as number | null;
  if (dueDays == null) {
    const { data: setting } = await supabase
      .from("system_settings")
      .select("value")
      .eq("key", "export_invoice_due_days")
      .single();
    dueDays = (setting?.value as number) ?? 30;
  }

  // Load current line items.
  const { data: currentItems, error: itemsErr } = await supabase
    .from("invoice_line_items")
    .select("id, sort_order, description, quantity, unit_price_cents, total_cents, square_catalog_variation_id")
    .eq("invoice_id", invoiceId)
    .order("sort_order");
  if (itemsErr) return NextResponse.json({ error: itemsErr.message }, { status: 500 });

  // Build updated items list.
  type StoredItem = {
    id: string; sort_order: number; description: string | null;
    quantity: number; unit_price_cents: number; total_cents: number;
    square_catalog_variation_id: string | null;
  };

  let updatedItems: StoredItem[] = currentItems ?? [];

  if (body.action === "add") {
    if (body.quantity <= 0 || body.unit_price_cents < 0 || isNaN(body.quantity) || isNaN(body.unit_price_cents)) {
      return NextResponse.json({ error: "quantity must be a positive number and unit_price_cents must be non-negative" }, { status: 400 });
    }
    const newItem: StoredItem = {
      id: crypto.randomUUID(),
      sort_order: updatedItems.length,
      description: body.description,
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
            description: body.description ?? item.description,
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

  const lineItemsForSquare = updatedItems.map((item) => ({
    id: item.id,
    description: item.description ?? "",
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
      dueDays,
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
    })
    .eq("id", invoiceId);
  if (invUpdateErr) return NextResponse.json({ error: invUpdateErr.message }, { status: 500 });

  // Replace all line items in DB.
  const { error: deleteErr } = await supabase.from("invoice_line_items").delete().eq("invoice_id", invoiceId);
  if (deleteErr) return NextResponse.json({ error: deleteErr.message }, { status: 500 });
  if (updatedItems.length > 0) {
    const { error: insertErr } = await supabase.from("invoice_line_items").insert(
      updatedItems.map((item, i) => ({
        invoice_id: invoiceId,
        sort_order: i,
        description: item.description,
        category: "other_services",
        quantity: item.quantity,
        unit_price_cents: item.unit_price_cents,
        total_cents: item.total_cents,
        square_catalog_variation_id: item.square_catalog_variation_id,
      }))
    );
    if (insertErr) return NextResponse.json({ error: insertErr.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
