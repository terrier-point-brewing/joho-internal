/**
 * PATCH /api/finance/ledger/invoice-line-items
 * Updates fields on a single invoice line item.
 * Accepted fields: chart_of_accounts_id
 */
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

type Body = {
  id: string;
  chart_of_accounts_id?: string | null;
};

export async function PATCH(req: NextRequest) {
  try { await requireRole([]); } catch (res) { return res as Response; }

  const body = await req.json() as Body;
  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const patch: Record<string, string | null> = {};
  if ("chart_of_accounts_id"    in body) patch.chart_of_accounts_id    = body.chart_of_accounts_id    ?? null;

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  const supabase = createSupabaseAdminClient();
  const { error } = await supabase
    .from("invoice_line_items")
    .update(patch)
    .eq("id", body.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
