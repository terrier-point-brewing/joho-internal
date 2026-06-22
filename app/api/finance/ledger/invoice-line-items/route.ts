/**
 * PATCH /api/finance/ledger/invoice-line-items
 * Updates fields on a single invoice line item.
 * Accepted fields: chart_of_accounts_id, bs_chart_of_accounts_id,
 *   pl_chart_of_accounts_id, delivery_invoice_id, account_mode
 */
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

type Body = {
  id: string;
  chart_of_accounts_id?: string | null;
  bs_chart_of_accounts_id?: string | null;
  pl_chart_of_accounts_id?: string | null;
  delivery_invoice_id?: string | null;
  account_mode?: "force_bs" | "force_pl" | null;
};

export async function PATCH(req: NextRequest) {
  try { await requireRole([]); } catch (res) { return res as Response; }

  const body = await req.json() as Body;
  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const patch: Record<string, string | null> = {};
  if ("chart_of_accounts_id"    in body) patch.chart_of_accounts_id    = body.chart_of_accounts_id    ?? null;
  if ("bs_chart_of_accounts_id" in body) patch.bs_chart_of_accounts_id = body.bs_chart_of_accounts_id ?? null;
  if ("pl_chart_of_accounts_id" in body) patch.pl_chart_of_accounts_id = body.pl_chart_of_accounts_id ?? null;
  if ("delivery_invoice_id"     in body) patch.delivery_invoice_id     = body.delivery_invoice_id     ?? null;
  if ("account_mode"            in body) patch.account_mode            = body.account_mode            ?? null;

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
