// lib/production/exportInvoiceLedger.ts
//
// The finance ledger row an export invoice writes, and the batch links that
// hang off it. The export invoice route's generate / record / mark_paid actions
// each wrote the same upsert and the same link loop by hand; the only things
// that differed between them are the fields a caller passes in here.

import type { SupabaseClient } from "@supabase/supabase-js";

export interface ExportInvoiceRowInput {
  source: "square" | "quickbooks" | "other";
  external_id: string;
  invoice_number: string | null;
  partner_id: string;
  customer_name: string | null;
  /** YYYY-MM-DD */
  invoice_date: string;
  status: "draft" | "open" | "paid";
  subtotal_cents: number;
  total_cents: number;
  shipped_channel: string;
  billed_channel: string;
  override_reason: string | null;
  line_edits: unknown[] | null;
  line_edit_reason: string | null;
  /** Square-backed rows only. */
  square_invoice_id?: string;
  due_date?: string;
  customer_note?: string | null;
  /** Hand-recorded rows only. */
  notes?: string;
}

/**
 * Upsert the `invoices` row for an export invoice, keyed on (source, external_id)
 * like every other ledger write, and return its id.
 */
export async function upsertExportInvoiceRow(
  supabase: SupabaseClient,
  row: ExportInvoiceRowInput,
): Promise<{ id: string | null; error: string | null }> {
  const { data, error } = await supabase
    .from("invoices")
    .upsert(
      { invoice_type: "export_invoice", tax_cents: 0, ...row },
      { onConflict: "source,external_id", ignoreDuplicates: false },
    )
    .select("id")
    .single();
  if (error || !data?.id) return { id: null, error: error?.message ?? "invoices upsert returned no row" };
  return { id: data.id as string, error: null };
}

/**
 * Link an invoice to every distinct batch in `batchIds`. Duplicates and nulls
 * are dropped; an existing link is left alone.
 */
export async function linkInvoiceBatches(
  supabase: SupabaseClient,
  invoiceId: string,
  batchIds: Array<string | null | undefined>,
): Promise<void> {
  const distinct = [...new Set(batchIds.filter((id): id is string => !!id))];
  if (distinct.length === 0) return;
  await supabase.from("invoice_batch_links").upsert(
    distinct.map((batchId) => ({ invoice_id: invoiceId, batch_id: batchId })),
    { onConflict: "invoice_id,batch_id", ignoreDuplicates: true },
  );
}
