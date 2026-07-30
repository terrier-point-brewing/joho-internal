import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createSupabaseServerClient();

  const { data: txs, error } = await supabase
    .from("export_transactions")
    .select(`
      id, shipment_id, recipe_id, channel, recipient_id, recipient_name, variant_label,
      quantity, volume_bbl, total_excise_tax_usd, status, invoice_id, allocation_id,
      packaging_item_id, packaging_format, source_ref, notes,
      is_phantom, alert_acknowledged_at,
      created_at,
      brew_batches(id, beer_name, batch_number),
      recipes(beer_name),
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

    // A phantom draft swap has no batch, but it always has a recipe. Surfacing
    // the recipe name lets the client name the beer instead of falling back to
    // a bare "Unknown" that reads like corrupt data.
    const recRaw = tx.recipes as unknown;
    const rec = Array.isArray(recRaw)
      ? (recRaw[0] as { beer_name: string } | undefined)
      : (recRaw as { beer_name: string } | null);

    return {
      ...tx,
      invoice_number: inv?.invoice_number ?? null,
      packaging_item_type: pi?.type ?? null,
      packaging_item_volume_fl_oz: pi?.volume_fl_oz ?? null,
      packaging_item_name: pi?.name ?? null,
      recipe_beer_name: rec?.beer_name ?? null,
      invoices: undefined,
      packaging_items: undefined,
      recipes: undefined,
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
