/**
 * POST /api/finance/transactions/auto-map?year=YYYY
 * Retroactively map unmapped POS line items in the year from catalog-variation
 * mappings. Logic lives in lib/finance/autoMap so the same pass runs from the
 * catalog-variation rule-edit trigger. Returns { mapped }.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { autoMapPosLineItems } from "@/lib/finance/autoMap";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try { await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }
  const year = parseInt(req.nextUrl.searchParams.get("year") ?? String(new Date().getFullYear()));
  const supabase = createSupabaseAdminClient();
  try {
    const result = await autoMapPosLineItems(supabase, { year });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "auto-map failed" }, { status: 500 });
  }
}
