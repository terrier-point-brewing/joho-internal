import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSessionUser } from "@/lib/auth";

// ── POST /api/finance/ledger/invoice-batch-links ───────────────────────────────
// Body: { invoice_id, batch_id, note? }
export async function POST(req: NextRequest) {
  try { await requireRole("admin"); } catch (res) { return res as Response; }

  const supabase  = createSupabaseAdminClient();
  const user      = await getSessionUser();
  const { invoice_id, batch_id, note } = await req.json();

  if (!invoice_id || !batch_id) {
    return NextResponse.json({ error: "invoice_id and batch_id are required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("invoice_batch_links")
    .insert({ invoice_id, batch_id, note: note ?? null, created_by: user?.user.id ?? null })
    .select(`
      id, note, created_at,
      invoices(id, invoice_number, invoice_date, customer_name, total_cents),
      brew_batches(id, beer_name, batch_number, planned_brew_date)
    `)
    .single();

  if (error) {
    // unique constraint violation → already linked
    if (error.code === "23505") {
      return NextResponse.json({ error: "This invoice is already linked to that batch" }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data, { status: 201 });
}

// ── GET /api/finance/ledger/invoice-batch-links ────────────────────────────────
// Optional: ?batch_id=<uuid> or ?invoice_id=<uuid>
export async function GET(req: NextRequest) {
  try { await requireRole("admin"); } catch (res) { return res as Response; }

  const supabase = createSupabaseAdminClient();
  const params   = req.nextUrl.searchParams;

  let query = supabase
    .from("invoice_batch_links")
    .select(`
      id, note, created_at,
      invoices(id, invoice_number, invoice_date, customer_name, total_cents),
      brew_batches(id, beer_name, batch_number, planned_brew_date)
    `)
    .order("created_at", { ascending: false });

  if (params.get("batch_id"))   query = query.eq("batch_id", params.get("batch_id")!);
  if (params.get("invoice_id")) query = query.eq("invoice_id", params.get("invoice_id")!);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
