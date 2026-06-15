/**
 * PATCH /api/finance/transactions/line-items
 *
 * Updates a single transaction line item's CoA mapping override and/or notes.
 * Body: { id: string; chart_of_accounts_id: string | null; notes?: string }
 */
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest) {
  try { await requireRole("admin"); } catch (res) { return res as Response; }

  const body = await req.json() as { id: string; chart_of_accounts_id: string | null; notes?: string };
  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const supabase = createSupabaseAdminClient();

  const patch: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if ("chart_of_accounts_id" in body) patch.chart_of_accounts_id = body.chart_of_accounts_id;
  if ("notes" in body) patch.notes = body.notes ?? null;

  const { error } = await supabase
    .from("pos_line_items")
    .update(patch)
    .eq("id", body.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
