import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  try { await requireRole(["viewer", "brewer", "manager"]); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from("invoices")
    .select(`
      id, invoice_number, invoice_date, customer_name, partner_id,
      status, source, square_invoice_id, subtotal_cents, total_cents,
      invoice_line_items(
        id, sort_order, description, category,
        quantity, unit_price_cents, total_cents,
        square_catalog_variation_id
      ),
      export_transactions!invoice_id(
        id, channel, variant_label, quantity, volume_bbl, created_at,
        brew_batches(id, beer_name, batch_number)
      ),
      contract_brewing_partners!partner_id(company_name)
    `)
    .not("partner_id", "is", null)
    .eq("invoice_type", "standard")
    .order("invoice_date", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const enriched = (data ?? []).map((inv) => {
    const partner = inv.contract_brewing_partners as { company_name: string } | null;
    return {
      id: inv.id,
      invoice_number: inv.invoice_number,
      invoice_date: inv.invoice_date,
      customer_name: inv.customer_name,
      partner_id: inv.partner_id,
      partner_name: partner?.company_name ?? null,
      status: inv.status,
      source: inv.source,
      square_invoice_id: inv.square_invoice_id,
      subtotal_cents: inv.subtotal_cents,
      total_cents: inv.total_cents,
      line_items: (inv.invoice_line_items ?? []).sort(
        (a: { sort_order: number }, b: { sort_order: number }) => a.sort_order - b.sort_order
      ),
      shipments: inv.export_transactions ?? [],
    };
  });

  return NextResponse.json(enriched);
}
