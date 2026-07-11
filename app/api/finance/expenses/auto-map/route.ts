/**
 * POST /api/finance/expenses/auto-map?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Re-apply source-account rules to unmapped, non-manual expenses in range. Logic
 * lives in lib/finance/autoMap. Returns { mapped }.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { autoMapExpenses } from "@/lib/finance/autoMap";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try { await requireRole([]); } catch (res) { return res as Response; }
  const from = req.nextUrl.searchParams.get("from");
  const to   = req.nextUrl.searchParams.get("to");
  if (!from || !to) return NextResponse.json({ error: "from and to required" }, { status: 400 });
  const supabase = createSupabaseAdminClient();
  try {
    const result = await autoMapExpenses(supabase, { from, to });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "auto-map failed" }, { status: 500 });
  }
}
