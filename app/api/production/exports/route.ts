import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createSupabaseServerClient();

  const { data: txs, error } = await supabase
    .from("export_transactions")
    .select("*, brew_batches(id, beer_name, batch_number)")
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Enrich with invoice_number from the invoices table, keyed on square_invoice_id.
  const squareIds = [
    ...new Set(
      (txs ?? []).flatMap((t) => (t.square_invoice_id ? [t.square_invoice_id as string] : []))
    ),
  ];

  let invNumBySquareId: Record<string, string | null> = {};
  if (squareIds.length > 0) {
    const { data: invoiceRows } = await supabase
      .from("invoices")
      .select("square_invoice_id, invoice_number")
      .in("square_invoice_id", squareIds);
    invNumBySquareId = Object.fromEntries(
      (invoiceRows ?? []).map((i) => [i.square_invoice_id as string, i.invoice_number as string | null])
    );
  }

  const enriched = (txs ?? []).map((tx) => ({
    ...tx,
    invoice_number: tx.square_invoice_id
      ? (invNumBySquareId[tx.square_invoice_id] ?? null)
      : null,
  }));

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
