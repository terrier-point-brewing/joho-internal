import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { classifyLineItem } from "@/lib/finance/classify";
import type { InvoiceImportPayload, InvoiceStatus } from "@/types/finance";

export const dynamic = "force-dynamic";

// ── GET /api/finance/ledger/invoices ──────────────────────────────────────────
// Returns all invoices with line-item counts and batch-link counts.
// Optional query params: ?source=quickbooks&year=2024&partner_id=<uuid>
export async function GET(req: NextRequest) {
  try { await requireRole("admin"); } catch (res) { return res as Response; }

  const supabase = createSupabaseAdminClient();
  const params   = req.nextUrl.searchParams;

  let query = supabase
    .from("invoices")
    .select(`
      *,
      contract_brewing_partners(company_name),
      invoice_line_items( id, sort_order, description, category, quantity, unit_price_cents, total_cents, variation_name, chart_of_accounts_id, bs_chart_of_accounts_id, pl_chart_of_accounts_id, delivery_invoice_id, account_mode, chart_of_accounts( id, account_name, account_number, account_type ) ),
      invoice_batch_links(count)
    `)
    .order("invoice_date", { ascending: false });

  if (params.get("source"))     query = query.eq("source", params.get("source")!);
  if (params.get("partner_id")) query = query.eq("partner_id", params.get("partner_id")!);
  if (params.get("year")) {
    const y = params.get("year")!;
    query = query.gte("invoice_date", `${y}-01-01`).lte("invoice_date", `${y}-12-31`);
  }

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

// ── POST /api/finance/ledger/invoices ─────────────────────────────────────────
// Bulk-inserts invoices from the import page.
// Body: { invoices: InvoiceImportPayload[] }
// Uses upsert on (source, external_id) to make re-imports idempotent.
export async function POST(req: NextRequest) {
  try { await requireRole("admin"); } catch (res) { return res as Response; }

  const supabase = createSupabaseAdminClient();
  const body: { invoices: InvoiceImportPayload[] } = await req.json();

  if (!Array.isArray(body.invoices) || body.invoices.length === 0) {
    return NextResponse.json({ error: "invoices array is required" }, { status: 400 });
  }

  let inserted = 0;
  let updated  = 0;
  const errors: string[] = [];

  for (const inv of body.invoices) {
    // Upsert the invoice header
    const { data: invRow, error: invErr } = await supabase
      .from("invoices")
      .upsert(
        {
          source:         inv.source,
          external_id:    inv.external_id,
          invoice_number: inv.invoice_number,
          invoice_date:   inv.invoice_date,
          due_date:       inv.due_date,
          customer_name:  inv.customer_name,
          status:         (inv.status ?? "unknown") as InvoiceStatus,
          subtotal_cents: inv.subtotal_cents,
          tax_cents:      inv.tax_cents,
          total_cents:    inv.total_cents,
          notes:          inv.notes,
          raw_data:       inv.raw_data,
        },
        { onConflict: "source,external_id", ignoreDuplicates: false }
      )
      .select("id, created_at, updated_at")
      .single();

    if (invErr || !invRow) {
      errors.push(`Invoice ${inv.invoice_number}: ${invErr?.message ?? "unknown error"}`);
      continue;
    }

    // Determine insert vs update for the summary count
    const wasInserted = invRow.created_at === invRow.updated_at;
    if (wasInserted) inserted++; else updated++;

    // Replace line items (delete + re-insert keeps sort_order stable)
    await supabase.from("invoice_line_items").delete().eq("invoice_id", invRow.id);

    if (inv.line_items.length > 0) {
      const { error: liErr } = await supabase.from("invoice_line_items").insert(
        inv.line_items.map((li) => ({
          invoice_id:       invRow.id,
          sort_order:       li.sort_order,
          description:      li.description,
          category:         classifyLineItem(li.description ?? ""),
          quantity:         li.quantity,
          unit_price_cents: li.unit_price_cents,
          total_cents:      li.total_cents,
          raw_data:         li.raw_data,
        }))
      );
      if (liErr) errors.push(`Line items for ${inv.invoice_number}: ${liErr.message}`);
    }
  }

  return NextResponse.json({
    inserted,
    updated,
    errors: errors.length ? errors : undefined,
  }, { status: errors.length && inserted + updated === 0 ? 500 : 200 });
}
