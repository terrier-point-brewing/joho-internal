/**
 * PATCH /api/finance/transactions/line-items
 *
 * Updates a single transaction line item's CoA mapping override and/or notes.
 * Body: { id: string; chart_of_accounts_id: string | null; notes?: string }
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest) {
  try { await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }

  const body = await req.json() as { id: string; chart_of_accounts_id: string | null; notes?: string };
  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const supabase = createSupabaseAdminClient();

  const patch: Record<string, unknown> = {
  };
  if ("chart_of_accounts_id" in body) {
    patch.chart_of_accounts_id = body.chart_of_accounts_id;
    // This route is the ONLY writer that marks a mapping as a person's choice —
    // the Square sync and the auto-map pass both write chart_of_accounts_id
    // from the catalog rule and leave the flag alone. Clearing the account
    // clears the flag with it: an emptied line falls back to the catalog
    // prefill at read time, which is a rule, not an override.
    patch.gl_manually_set = body.chart_of_accounts_id != null;
  }
  if ("notes" in body) patch.notes = body.notes ?? null;

  const { error } = await supabase
    .from("pos_line_items")
    .update(patch)
    .eq("id", body.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
