import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createSupabaseServerClient();

  const { data: txs, error } = await supabase
    .from("export_transactions")
    .select(`
      id, channel, recipient_id, recipient_name, variant_label,
      quantity, volume_bbl, total_excise_tax_usd, status, invoice_id,
      created_at,
      brew_batches(id, beer_name, batch_number),
      invoices!invoice_id(invoice_number)
    `)
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const enriched = (txs ?? []).map((tx) => {
    // Supabase may return the FK-joined row as an array or object depending on
    // the relationship direction. Normalize to the object shape we need.
    const invRaw = tx.invoices as unknown;
    const inv = Array.isArray(invRaw)
      ? (invRaw[0] as { invoice_number: string | null } | undefined)
      : (invRaw as { invoice_number: string | null } | null);
    return {
      ...tx,
      invoice_number: inv?.invoice_number ?? null,
      invoices: undefined,
    };
  });

  return NextResponse.json(enriched);
}

// All exports must go through /api/production/export-bay/ship to enforce
// inventory depletion + allocation crediting. Direct inserts to
// export_transactions are blocked here.
export async function POST() {
  return NextResponse.json(
    { error: "Use /api/production/export-bay/ship to record exports" },
    { status: 405 }
  );
}
