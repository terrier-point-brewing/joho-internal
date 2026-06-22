import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createExportInvoice } from "@/lib/square/export-invoices";
import { syncSquareInvoicesForYear } from "@/lib/finance/syncSquareInvoices";
import type { InvoiceLineItemDraft } from "@/lib/production/exportInvoicePreview";

export const dynamic = "force-dynamic";

interface CreateInvoiceBody {
  transactionIds: string[];
  lineItems: InvoiceLineItemDraft[];
}

export async function POST(req: NextRequest) {
  try { await requireRole(["brewer"]); } catch (res) { return res as Response; }

  let body: CreateInvoiceBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { transactionIds, lineItems } = body;

  if (!transactionIds?.length) {
    return NextResponse.json({ error: "transactionIds is required" }, { status: 400 });
  }
  if (!lineItems?.length) {
    return NextResponse.json({ error: "At least one line item is required" }, { status: 400 });
  }
  if (lineItems.some((li) => li.quantity <= 0 || li.unitPriceCents < 0)) {
    return NextResponse.json({ error: "Line item quantity must be positive and price cannot be negative" }, { status: 400 });
  }

  const supabase = createSupabaseAdminClient();

  // ── Re-validate same-customer + invoice_required server-side ─────────────
  const { data: txs, error: txErr } = await supabase
    .from("export_transactions")
    .select("id, recipient_id, status")
    .in("id", transactionIds);
  if (txErr) return NextResponse.json({ error: txErr.message }, { status: 500 });
  if (!txs || txs.length !== transactionIds.length) {
    return NextResponse.json({ error: "One or more export transactions were not found" }, { status: 400 });
  }
  const customerIds = new Set(txs.map((t) => t.recipient_id));
  if (customerIds.size !== 1 || txs[0].recipient_id == null) {
    return NextResponse.json({ error: "All selected transactions must belong to the same customer" }, { status: 400 });
  }
  if (txs.some((t) => t.status !== "invoice_required")) {
    return NextResponse.json({ error: "All selected transactions must be in Invoice Required status" }, { status: 400 });
  }
  const customerId = txs[0].recipient_id as string;

  const { data: partner, error: partnerErr } = await supabase
    .from("contract_brewing_partners")
    .select("company_name, square_customer_id, export_net_terms_days")
    .eq("id", customerId)
    .single();
  if (partnerErr) return NextResponse.json({ error: partnerErr.message }, { status: 500 });
  if (!partner) return NextResponse.json({ error: "Customer not found" }, { status: 400 });
  if (!partner.square_customer_id) {
    return NextResponse.json({ error: "This partner has no linked Square customer — add one in Contract Brewing Partners before invoicing" }, { status: 400 });
  }

  let dueDays = partner.export_net_terms_days as number | null;
  if (dueDays == null) {
    const { data: setting, error: settingErr } = await supabase
      .from("system_settings")
      .select("value")
      .eq("key", "export_invoice_due_days")
      .single();
    if (settingErr) console.error("[export-invoice] failed to fetch export_invoice_due_days setting:", settingErr);
    dueDays = (setting?.value as number) ?? 30;
  }

  // ── Create + publish the Square invoice ───────────────────────────────────
  let result;
  try {
    result = await createExportInvoice({
      squareCustomerId: partner.square_customer_id,
      title: `Export Invoice — ${partner.company_name}`,
      lineItems,
      dueDays,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Square invoice creation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  // ── Update transaction state ───────────────────────────────────────────────
  const { error: updateErr } = await supabase
    .from("export_transactions")
    .update({ square_invoice_id: result.invoiceId, status: "unpaid" })
    .in("id", transactionIds);
  if (updateErr) {
    // The Square invoice now exists but our local state didn't update —
    // surface this loudly rather than silently losing the link.
    return NextResponse.json(
      { error: `Invoice ${result.invoiceId} was created in Square but updating local records failed: ${updateErr.message}` },
      { status: 500 }
    );
  }

  // ── Best-effort Finance ledger refresh ────────────────────────────────────
  try {
    await syncSquareInvoicesForYear(supabase, new Date().getFullYear());
  } catch (err) {
    console.error("[export-invoice] post-create Finance sync failed:", err);
  }

  return NextResponse.json({ invoiceId: result.invoiceId, invoiceUrl: result.invoiceUrl });
}
