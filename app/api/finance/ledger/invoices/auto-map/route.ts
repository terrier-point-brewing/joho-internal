/**
 * POST /api/finance/ledger/invoices/auto-map?year=YYYY
 * Retroactively map unmapped invoice line items by description + catalog-variation
 * mappings. Logic lives in lib/finance/autoMap. Returns { mapped }.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { autoMapInvoiceLineItems } from "@/lib/finance/autoMap";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try { await requireRole([]); } catch (res) { return res as Response; }
  const year = parseInt(req.nextUrl.searchParams.get("year") ?? String(new Date().getFullYear()));
  const supabase = createSupabaseAdminClient();
  try {
    const result = await autoMapInvoiceLineItems(supabase, { year });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "auto-map failed" }, { status: 500 });
  }
}
