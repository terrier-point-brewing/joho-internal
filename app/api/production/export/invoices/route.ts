import { NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * Flatten a shipment's `recipes` embed to `recipe_beer_name`.
 *
 * A draft-recount / phantom shipment has no batch but always has a recipe, so
 * the batch beer name alone leaves those rows nameless — which makes them
 * invisible to a recipe search and blank in the Included Shipments table.
 * Mirrors the same normalization in /api/production/exports.
 */
function normalizeShipment(tx: Record<string, unknown>) {
  const recRaw = tx.recipes as unknown;
  const rec = Array.isArray(recRaw)
    ? (recRaw[0] as { beer_name: string } | undefined)
    : (recRaw as { beer_name: string } | null);
  return { ...tx, recipe_beer_name: rec?.beer_name ?? null, recipes: undefined };
}

export async function GET() {
  try { await requirePermission(CAP.exportRead); } catch (res) { return res as Response; }

  // `invoices` (and its `invoice_line_items` embed) is RLS-locked to admins, but
  // this route legitimately serves viewer/brewer/manager. The requirePermission gate
  // above is the authorization boundary; read via the service-role client so the
  // admin-only RLS policy doesn't silently filter every row (mirrors the invoice
  // write routes, which already use the admin client).
  const supabase = createSupabaseAdminClient();

  const { data, error } = await supabase
    .from("invoices")
    .select(`
      id, invoice_number, invoice_date, customer_name, partner_id,
      status, source, square_invoice_id, subtotal_cents, total_cents,
      invoice_line_items!invoice_line_items_invoice_id_fkey(
        id, sort_order, line_item_name, variation_name, description, note, category,
        quantity, unit_price_cents, total_cents,
        square_catalog_variation_id
      ),
      export_transactions!invoice_id(
        id, status, channel, variant_label, quantity, volume_bbl, created_at,
        recipe_id,
        brew_batches(id, beer_name, batch_number),
        recipes(beer_name)
      ),
      export_invoice_material_components(
        id, recipe_id, beer_name, variant_label, packaging_format, packages,
        units_per_package, component_role, component_name, unit_cost,
        quantity_used, line_total_cents, sort_order
      ),
      contract_brewing_partners!partner_id(company_name)
    `)
    .not("partner_id", "is", null)
    .eq("invoice_type", "export_invoice")
    .order("invoice_date", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const enriched = (data ?? []).map((inv) => {
    const partner = inv.contract_brewing_partners as unknown as { company_name: string } | null;
    // Square's public_url is only populated after an invoice is sent, so it's
    // always null for drafts. Link to the Square Dashboard invoice instead —
    // valid for drafts and published alike (mirrors the deposit-invoice flow).
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
      subtotal_cents: inv.subtotal_cents,
      total_cents: inv.total_cents,
      line_items: (inv.invoice_line_items ?? []).sort(
        (a: { sort_order: number }, b: { sort_order: number }) => a.sort_order - b.sort_order
      ),
      shipments: (inv.export_transactions ?? []).map(normalizeShipment),
      // Frozen Packaging Materials derivation (contract brewing only; empty
      // otherwise, and for invoices generated before this was captured).
      material_breakdown: (inv.export_invoice_material_components ?? []).sort(
        (a: { sort_order: number }, b: { sort_order: number }) => a.sort_order - b.sort_order
      ),
    };
  });

  return NextResponse.json(enriched);
}
