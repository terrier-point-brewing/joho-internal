import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { buildInvoiceSalesReport } from "@/lib/finance/invoiceSalesReport";
import { apiError } from "@/lib/utils/api";

export const dynamic = "force-dynamic";

// Ledger-backed invoice sales: groups export invoices by channel
// (distribution | contract_brewing | wholesale) using the established
// invoice ↔ export_transactions linkage, rather than re-parsing live Square
// line-item names. See lib/finance/invoiceSalesReport.ts for the full rationale.
export async function GET(req: NextRequest) {
  try { await requireRole([]); } catch (res) { return res as Response; }

  try {
    const year = parseInt(req.nextUrl.searchParams.get("year") ?? String(new Date().getFullYear()));
    const supabase = await createSupabaseServerClient();
    const report = await buildInvoiceSalesReport(supabase, year);
    return NextResponse.json(report);
  } catch (err) {
    return apiError(err);
  }
}
