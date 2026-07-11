// app/api/taproom/draft-stats/backfill/route.ts
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { backfillDraftShrinkage } from "@/lib/production/backfillDraftShrinkage";

export const dynamic = "force-dynamic";

// POST { apply?: boolean } — recompute remaining_fl_oz for every stored
// draft_swap_shrinkage row as last-recount-minus-pours-since, correcting rows
// written before the pour-ledger reconstruction fix. Admin only. Dry-run unless
// apply === true.
export async function POST(req: NextRequest) {
  try { await requireRole([]); } catch (res) { return res as Response; }

  const body = await req.json().catch(() => ({}));
  const apply = body?.apply === true;
  const db = createSupabaseAdminClient();

  try {
    const result = await backfillDraftShrinkage(db, { apply });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
