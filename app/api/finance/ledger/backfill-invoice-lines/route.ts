import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { syncSquareInvoicesForYear } from "@/lib/finance/syncSquareInvoices";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try { await requireRole(["admin"]); } catch (res) { return res as Response; }
  const year = parseInt(req.nextUrl.searchParams.get("year") ?? String(new Date().getFullYear()));
  const supabase = createSupabaseAdminClient();
  // The year-sync already rewrites every Square invoice's line items via the shared mapper,
  // which covers export_invoice and allocation_deposit rows (both are source=square).
  const result = await syncSquareInvoicesForYear(supabase, year);
  return NextResponse.json(result);
}
