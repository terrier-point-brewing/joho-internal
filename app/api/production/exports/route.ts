import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  try { await requireRole(["viewer"]); } catch (res) { return res as Response; }

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
    const rawInv = Array.isArray(tx.invoices) ? tx.invoices[0] : tx.invoices;
    const inv = rawInv as { invoice_number: string | null } | null | undefined;
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
