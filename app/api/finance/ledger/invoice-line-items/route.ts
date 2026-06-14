/**
 * PATCH /api/finance/ledger/invoice-line-items
 * Updates chart_of_accounts_id on a single invoice line item.
 * Body: { id: string; chart_of_accounts_id: string | null }
 */
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest) {
  try { await requireRole("admin"); } catch (res) { return res as Response; }

  const body = await req.json() as { id: string; chart_of_accounts_id: string | null };
  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const supabase = createSupabaseAdminClient();
  const { error } = await supabase
    .from("invoice_line_items")
    .update({ chart_of_accounts_id: body.chart_of_accounts_id })
    .eq("id", body.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
