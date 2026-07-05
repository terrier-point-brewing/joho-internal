import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createSupabaseServerClient();

  const { data: txs, error } = await supabase
    .from("export_transactions")
    .select(`
      id, shipment_id, recipe_id, channel, recipient_id, recipient_name, variant_label,
      quantity, volume_bbl, total_excise_tax_usd, status, invoice_id,
      packaging_item_id, packaging_format, source_ref,
      created_at,
      brew_batches(id, beer_name, batch_number),
      invoices!invoice_id(invoice_number),
      packaging_items!packaging_item_id(type, volume_fl_oz, name)
    `)
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const enriched = (txs ?? []).map((tx) => {
    // Supabase may return FK-joined rows as an array or object — normalize both.
    const invRaw = tx.invoices as unknown;
    const inv = Array.isArray(invRaw)
      ? (invRaw[0] as { invoice_number: string | null } | undefined)
      : (invRaw as { invoice_number: string | null } | null);

    const piRaw = tx.packaging_items as unknown;
    const pi = Array.isArray(piRaw)
      ? (piRaw[0] as { type: string; volume_fl_oz: number | null; name: string } | undefined)
      : (piRaw as { type: string; volume_fl_oz: number | null; name: string } | null);

    return {
      ...tx,
      invoice_number: inv?.invoice_number ?? null,
      packaging_item_type: pi?.type ?? null,
      packaging_item_volume_fl_oz: pi?.volume_fl_oz ?? null,
      packaging_item_name: pi?.name ?? null,
      invoices: undefined,
      packaging_items: undefined,
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
