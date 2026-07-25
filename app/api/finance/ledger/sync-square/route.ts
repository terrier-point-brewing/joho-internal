/**
 * POST /api/finance/ledger/sync-square?year=YYYY
 *
 * Fetches Square invoices for the given year and upserts them into the ledger
 * (`invoices` + `invoice_line_items`). Idempotent: re-running updates existing
 * records via the (source, external_id) unique constraint.
 *
 * Logic lives in lib/finance/syncSquareInvoices.ts so the export-invoice
 * creation flow can trigger the same sync directly without an HTTP round-trip.
 */

import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { syncSquareInvoicesForYear } from "@/lib/finance/syncSquareInvoices";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try { await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }

  const year     = parseInt(req.nextUrl.searchParams.get("year") ?? String(new Date().getFullYear()));
  const supabase = createSupabaseAdminClient();

  try {
    const result = await syncSquareInvoicesForYear(supabase, year);
    return NextResponse.json(result, {
      status: result.errors?.length && result.synced + result.updated === 0 ? 500 : 200,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[sync-square]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
