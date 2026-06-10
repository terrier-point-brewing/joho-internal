import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

// ── GET /api/finance/ledger/invoices/[id] ─────────────────────────────────────
// Full invoice with line items and linked batches.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try { await requireRole("admin"); } catch (res) { return res as Response; }

  const { id } = await params;
  const supabase = createSupabaseAdminClient();

  const { data, error } = await supabase
    .from("invoices")
    .select(`
      *,
      contract_brewing_partners(id, company_name),
      invoice_line_items(*),
      invoice_batch_links(
        id, note, created_at,
        brew_batches(id, beer_name, batch_number, planned_brew_date, volume_bbl, status)
      )
    `)
    .eq("id", id)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: error.code === "PGRST116" ? 404 : 500 });
  return NextResponse.json(data);
}

// ── PATCH /api/finance/ledger/invoices/[id] ───────────────────────────────────
// Update partner_id, notes, or status during reconciliation.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try { await requireRole("admin"); } catch (res) { return res as Response; }

  const { id } = await params;
  const supabase = createSupabaseAdminClient();
  const body = await req.json();

  const allowed = ["partner_id", "notes", "status"];
  const patch = Object.fromEntries(
    Object.entries(body).filter(([k]) => allowed.includes(k))
  );

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "No patchable fields provided" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("invoices")
    .update(patch)
    .eq("id", id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
