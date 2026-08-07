import { NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET() {
  try { await requirePermission(CAP.exportRead); } catch (res) { return res as Response; }

  // Admin client, not the server client: `invoices` and
  // `deposit_invoice_ingredients` both carry an admin-ONLY RLS policy (see
  // 20260609_invoices.sql / 20260709_deposit_invoice_ingredients.sql), so a
  // brewer passing the exportRead gate above still got a silent empty list.
  // The requirePermission call is the authorization gate — same pattern as
  // every sibling route that reads this table (export/invoices, export/invoice,
  // deposit-invoices/backfill).
  const supabase = createSupabaseAdminClient();

  const { data, error } = await supabase
    .from("invoices")
    .select(`
      id, invoice_number, invoice_date, customer_name, partner_id,
      status, source, square_invoice_id, total_cents,
      deposit_invoice_ingredients(
        id, ingredient_name, unit, quantity_per_bbl, cost_per_unit_usd, line_total_cents, sort_order
      ),
      contract_brewing_partners!partner_id(company_name),
      batch_allocations!allocation_id(
        percentage, invoice_generated_at, invoice_sent_at, invoice_paid_at,
        brew_batches(beer_name, batch_number, volume_bbl)
      )
    `)
    .eq("invoice_type", "allocation_deposit")
    .order("invoice_date", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const enriched = (data ?? []).map((inv) => {
    const partner = inv.contract_brewing_partners as unknown as { company_name: string } | null;
    const alloc = inv.batch_allocations as unknown as {
      percentage: number | null; invoice_generated_at: string | null;
      invoice_sent_at: string | null; invoice_paid_at: string | null;
      brew_batches: { beer_name: string; batch_number: string; volume_bbl: number } | null;
    } | null;
    const squareDashboardUrl = inv.square_invoice_id
      ? `https://app.squareup.com/dashboard/invoices/${inv.square_invoice_id}/edit?currentUnitToken=${process.env.SQUARE_LOCATION_ID}`
      : null;
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
      square_dashboard_url: squareDashboardUrl,
      total_cents: inv.total_cents,
      percentage: alloc?.percentage ?? null,
      beer_name: alloc?.brew_batches?.beer_name ?? null,
      batch_number: alloc?.brew_batches?.batch_number ?? null,
      volume_bbl: alloc?.brew_batches?.volume_bbl ?? null,
      generated_at: alloc?.invoice_generated_at ?? null,
      sent_at: alloc?.invoice_sent_at ?? null,
      paid_at: alloc?.invoice_paid_at ?? null,
      breakdown: (inv.deposit_invoice_ingredients ?? []).sort(
        (a: { sort_order: number }, b: { sort_order: number }) => a.sort_order - b.sort_order
      ),
    };
  });

  return NextResponse.json(enriched);
}
