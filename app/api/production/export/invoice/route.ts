import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createExportInvoice, publishInvoice, getInvoiceStatus } from "@/lib/square/square-invoices";
import { syncSquareInvoicesForYear } from "@/lib/finance/syncSquareInvoices";
import type { InvoiceLineItemDraft } from "@/lib/production/exportInvoicePreview";

export const dynamic = "force-dynamic";

interface PostBody {
  action: "generate" | "send" | "sync" | "mark_paid" | "record";
  transactionIds: string[];
  lineItems?: InvoiceLineItemDraft[];
  source?: string;
  external_ref?: string;
  paid_at?: string;
  total_cents?: number;
  invoice_date?: string;
}

export async function POST(req: NextRequest) {
  try { await requireRole(["brewer"]); } catch (res) { return res as Response; }

  let body: PostBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { action, transactionIds } = body;

  if (!["generate", "send", "sync", "mark_paid", "record"].includes(action)) {
    return NextResponse.json({ error: "action must be generate | send | sync | mark_paid | record" }, { status: 400 });
  }
  if (!transactionIds?.length) {
    return NextResponse.json({ error: "transactionIds is required" }, { status: 400 });
  }

  const supabase = createSupabaseAdminClient();

  const { data: txs, error: txErr } = await supabase
    .from("export_transactions")
    .select("id, recipient_id, recipient_name, status, invoice_id, batch_id")
    .in("id", transactionIds);
  if (txErr) return NextResponse.json({ error: txErr.message }, { status: 500 });
  if (!txs || txs.length !== transactionIds.length) {
    return NextResponse.json({ error: "One or more export transactions were not found" }, { status: 400 });
  }
  const customerIds = new Set(txs.map((t) => t.recipient_id));
  if (customerIds.size !== 1 || txs[0].recipient_id == null) {
    return NextResponse.json({ error: "All selected transactions must belong to the same customer" }, { status: 400 });
  }
  const customerId = txs[0].recipient_id as string;

  // ── generate ──────────────────────────────────────────────────────────────
  if (action === "generate") {
    const { lineItems } = body;
    if (!lineItems?.length) {
      return NextResponse.json({ error: "At least one line item is required" }, { status: 400 });
    }
    if (lineItems.some((li) => li.quantity <= 0 || li.unitPriceCents < 0)) {
      return NextResponse.json({ error: "Line item quantity must be positive and price cannot be negative" }, { status: 400 });
    }
    if (txs.some((t) => t.status !== "invoice_required")) {
      return NextResponse.json({ error: "All selected transactions must be in Invoice Required status" }, { status: 400 });
    }

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

    const today = new Date().toISOString().slice(0, 10);
    const totalCents = lineItems.reduce((s, li) => s + li.quantity * li.unitPriceCents, 0);

    // Upsert a Draft invoices row immediately so invoice_id can be set on txns.
    const { data: inv, error: invErr } = await supabase
      .from("invoices")
      .upsert(
        {
          source: "square",
          external_id: result.invoiceId,
          square_invoice_id: result.invoiceId,
          invoice_number: result.invoiceNumber ?? null,
          invoice_type: "export_invoice",
          partner_id: customerId,
          customer_name: partner.company_name,
          invoice_date: today,
          status: "draft",
          subtotal_cents: totalCents,
          tax_cents: 0,
          total_cents: totalCents,
        },
        { onConflict: "source,external_id", ignoreDuplicates: false }
      )
      .select("id")
      .single();
    if (invErr || !inv) {
      return NextResponse.json(
        { error: `Square invoice ${result.invoiceId} created but local invoices row failed: ${invErr?.message}` },
        { status: 500 }
      );
    }

    // Insert line items into invoice_line_items (with Square variation ID for future draft editing).
    if (lineItems.length > 0) {
      await supabase.from("invoice_line_items").insert(
        lineItems.map((li, i) => ({
          invoice_id: inv.id,
          sort_order: i,
          description: li.description,
          category: "other_services",
          quantity: li.quantity,
          unit_price_cents: li.unitPriceCents,
          total_cents: li.quantity * li.unitPriceCents,
          square_catalog_variation_id: li.squareCatalogVariationId ?? null,
        }))
      );
    }

    const { error: updateErr } = await supabase
      .from("export_transactions")
      .update({ invoice_id: inv.id })
      .in("id", transactionIds);
    if (updateErr) {
      return NextResponse.json(
        { error: `Invoice created but updating transaction records failed: ${updateErr.message}` },
        { status: 500 }
      );
    }

    // Create invoice_batch_links for distinct batches covered by these transactions
    const batchIds = [...new Set(
      txs.map((t) => (t as typeof t & { batch_id: string | null }).batch_id).filter((id): id is string => !!id)
    )];
    if (batchIds.length > 0) {
      await supabase.from("invoice_batch_links").upsert(
        batchIds.map((batchId) => ({ invoice_id: inv.id, batch_id: batchId })),
        { onConflict: "invoice_id,batch_id", ignoreDuplicates: true }
      );
    }

    return NextResponse.json({ invoiceId: result.invoiceId, invoiceUrl: result.invoiceUrl });
  }

  // ── send ──────────────────────────────────────────────────────────────────
  if (action === "send") {
    if (txs.some((t) => t.status !== "invoice_required")) {
      return NextResponse.json({ error: "These transactions have already been sent or paid" }, { status: 400 });
    }

    const invoiceId = txs[0].invoice_id;
    if (!invoiceId) {
      return NextResponse.json({ error: "No invoice has been generated yet — run generate first" }, { status: 400 });
    }
    if (txs.some((t) => t.invoice_id !== invoiceId)) {
      return NextResponse.json({ error: "Selected transactions belong to different invoices" }, { status: 400 });
    }

    // Look up the Square invoice ID via the invoices table.
    const { data: inv, error: invLookupErr } = await supabase
      .from("invoices")
      .select("square_invoice_id")
      .eq("id", invoiceId)
      .single();
    if (invLookupErr || !inv?.square_invoice_id) {
      return NextResponse.json({ error: "Invoice record not found or missing Square ID" }, { status: 400 });
    }
    const squareInvoiceId = inv.square_invoice_id as string;

    const currentStatus = await getInvoiceStatus(squareInvoiceId);
    if (currentStatus.status === "PAID") {
      return NextResponse.json({ error: "Invoice is already paid in Square — use sync to update status" }, { status: 422 });
    }
    if (currentStatus.status === "DRAFT") {
      await publishInvoice(squareInvoiceId);
    }

    const { error: txUpdateErr } = await supabase
      .from("export_transactions")
      .update({ status: "unpaid" })
      .in("id", transactionIds);
    if (txUpdateErr) return NextResponse.json({ error: txUpdateErr.message }, { status: 500 });

    await supabase
      .from("invoices")
      .update({ status: "open" })
      .eq("id", invoiceId);

    try {
      await syncSquareInvoicesForYear(supabase, new Date().getFullYear());
    } catch (err) {
      console.error("[export-invoice] post-send Finance sync failed:", err);
    }

    return NextResponse.json({ ok: true });
  }

  // ── sync ──────────────────────────────────────────────────────────────────
  if (action === "sync") {
    const invoiceId = txs[0].invoice_id;
    if (!invoiceId) {
      return NextResponse.json({ error: "No invoice to sync" }, { status: 400 });
    }
    if (txs.some((t) => t.invoice_id !== invoiceId)) {
      return NextResponse.json({ error: "Selected transactions belong to different invoices" }, { status: 400 });
    }

    const { data: inv, error: invLookupErr } = await supabase
      .from("invoices")
      .select("square_invoice_id")
      .eq("id", invoiceId)
      .single();
    if (invLookupErr || !inv?.square_invoice_id) {
      return NextResponse.json({ error: "Invoice record not found or missing Square ID" }, { status: 400 });
    }

    const squareStatus = await getInvoiceStatus(inv.square_invoice_id as string);

    if (squareStatus.status === "PAID") {
      const { error: txUpdateErr } = await supabase
        .from("export_transactions")
        .update({ status: "paid" })
        .in("id", transactionIds)
        .eq("status", "unpaid");
      if (txUpdateErr) return NextResponse.json({ error: txUpdateErr.message }, { status: 500 });

      await supabase
        .from("invoices")
        .update({ status: "paid" })
        .eq("id", invoiceId);
    }

    try {
      await syncSquareInvoicesForYear(supabase, new Date().getFullYear());
    } catch (err) {
      console.error("[export-invoice] post-sync Finance sync failed:", err);
    }

    return NextResponse.json({ squareStatus: squareStatus.status });
  }

  // ── record ────────────────────────────────────────────────────────────────
  if (action === "record") {
    const source = body.source as string;
    if (!["quickbooks", "other"].includes(source)) {
      return NextResponse.json({ error: "source must be quickbooks or other" }, { status: 422 });
    }

    const totalCents  = body.total_cents   as number | undefined;
    const externalRef = body.external_ref  as string | undefined;
    const invoiceDate = body.invoice_date  as string | undefined;
    const lineItems   = body.lineItems     as Array<{ description: string; quantity: number; unitPriceCents: number }> | undefined;

    if (!totalCents || totalCents <= 0) return NextResponse.json({ error: "total_cents must be positive" }, { status: 400 });
    if (source === "quickbooks" && !externalRef) return NextResponse.json({ error: "external_ref (QB invoice number) is required for quickbooks source" }, { status: 400 });
    if (txs.some((t) => t.status !== "invoice_required")) {
      return NextResponse.json({ error: "All selected transactions must be in Invoice Required status" }, { status: 400 });
    }

    const { error: updateErr } = await supabase
      .from("export_transactions")
      .update({ status: "unpaid" })
      .in("id", transactionIds);
    if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

    const externalId = externalRef ?? `other:${crypto.randomUUID()}`;
    const dbSource = source as "quickbooks" | "other";
    const { data: inv, error: invErr } = await supabase
      .from("invoices")
      .upsert(
        {
          source: dbSource,
          external_id:    externalId,
          invoice_number: externalRef ?? null,
          invoice_type:   "export_invoice",
          partner_id:     customerId,
          customer_name:  txs[0].recipient_name ?? null,
          invoice_date:   (invoiceDate ?? new Date().toISOString()).slice(0, 10),
          status:         "open",
          subtotal_cents: totalCents,
          tax_cents:      0,
          total_cents:    totalCents,
          notes:          "Manually created export invoice",
        },
        { onConflict: "source,external_id", ignoreDuplicates: false }
      )
      .select("id")
      .single();

    if (invErr || !inv) {
      return NextResponse.json({ error: `Failed to create invoice record: ${invErr?.message}` }, { status: 500 });
    }

    if (inv?.id) {
      if (lineItems?.length) {
        await supabase.from("invoice_line_items").insert(
          lineItems.map((li, i) => ({
            invoice_id:       inv.id,
            sort_order:       i,
            description:      li.description,
            category:         "other_services",
            quantity:         li.quantity,
            unit_price_cents: li.unitPriceCents,
            total_cents:      li.quantity * li.unitPriceCents,
          }))
        );
      }
      await supabase
        .from("export_transactions")
        .update({ invoice_id: inv.id })
        .in("id", transactionIds);

      // Create invoice_batch_links for distinct batches
      const batchIds = [...new Set(
        txs.map((t) => (t as typeof t & { batch_id: string | null }).batch_id).filter((id): id is string => !!id)
      )];
      if (batchIds.length > 0) {
        await supabase.from("invoice_batch_links").upsert(
          batchIds.map((batchId) => ({ invoice_id: inv.id, batch_id: batchId })),
          { onConflict: "invoice_id,batch_id", ignoreDuplicates: true }
        );
      }
    }

    return NextResponse.json({ ok: true });
  }

  // ── mark_paid ─────────────────────────────────────────────────────────────
  if (action === "mark_paid") {
    const source = body.source as string;
    if (!["quickbooks", "other"].includes(source)) {
      return NextResponse.json({ error: "source must be quickbooks or other" }, { status: 422 });
    }

    const paidAt      = body.paid_at     as string | undefined;
    const totalCents  = body.total_cents as number | undefined;
    const externalRef = body.external_ref as string | undefined;

    if (!paidAt)                                    return NextResponse.json({ error: "paid_at is required" }, { status: 400 });
    if (totalCents === undefined || totalCents < 0) return NextResponse.json({ error: "total_cents must be non-negative" }, { status: 400 });
    if (source === "quickbooks" && !externalRef)    return NextResponse.json({ error: "external_ref (QB invoice number) is required" }, { status: 400 });

    if (txs.some((t) => t.status !== "invoice_required")) {
      return NextResponse.json({ error: "All selected transactions must be in Invoice Required status" }, { status: 400 });
    }

    const { error: updateErr } = await supabase
      .from("export_transactions")
      .update({ status: "paid" })
      .in("id", transactionIds);
    if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

    const externalId = externalRef ?? `other:${crypto.randomUUID()}`;
    const { data: inv, error: invErr } = await supabase
      .from("invoices")
      .upsert(
        {
          source:         source as "quickbooks" | "other",
          external_id:    externalId,
          invoice_number: externalRef ?? null,
          invoice_type:   "export_invoice",
          partner_id:     customerId,
          customer_name:  txs[0].recipient_name ?? null,
          invoice_date:   paidAt.slice(0, 10),
          status:         "paid",
          subtotal_cents: totalCents,
          tax_cents:      0,
          total_cents:    totalCents,
          notes:          "QB backfill — export invoice",
        },
        { onConflict: "source,external_id", ignoreDuplicates: false }
      )
      .select("id")
      .single();

    if (invErr || !inv) {
      return NextResponse.json({ error: `Failed to create invoice record: ${invErr?.message}` }, { status: 500 });
    }

    if (inv?.id) {
      await supabase
        .from("export_transactions")
        .update({ invoice_id: inv.id })
        .in("id", transactionIds);

      // Create invoice_batch_links for distinct batches
      const batchIds = [...new Set(
        txs.map((t) => (t as typeof t & { batch_id: string | null }).batch_id).filter((id): id is string => !!id)
      )];
      if (batchIds.length > 0) {
        await supabase.from("invoice_batch_links").upsert(
          batchIds.map((batchId) => ({ invoice_id: inv.id, batch_id: batchId })),
          { onConflict: "invoice_id,batch_id", ignoreDuplicates: true }
        );
      }
    }

    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
