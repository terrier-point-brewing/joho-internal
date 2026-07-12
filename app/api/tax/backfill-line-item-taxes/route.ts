/**
 * On-demand backfill of `pos_line_item_taxes` for a historical date range.
 *
 * Re-fetches each already-synced POS order from Square and rebuilds its tax
 * rows (see lib/tax/backfillLineItemTaxes.ts) — for orders synced before
 * `pos_line_item_taxes` existed, or to re-derive rows after a mapping fix.
 * Idempotent, so safe to re-run over an overlapping or repeated range.
 *
 * Guarded like the cron routes (Bearer CRON_SECRET) but also callable by an
 * admin from the UI, since this is meant to be triggered on demand for a
 * historical range rather than only on a schedule.
 */
import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSessionUser } from "@/lib/auth";
import { backfillLineItemTaxesForRange } from "@/lib/tax/backfillLineItemTaxes";
import { apiError } from "@/lib/utils/api";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const isCron = auth === `Bearer ${process.env.CRON_SECRET}`;
  if (!isCron) {
    const session = await getSessionUser();
    if (!session || session.role !== "admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const { searchParams } = new URL(req.url);
  const start = searchParams.get("start");
  const end = searchParams.get("end");
  if (!start || !end) {
    return NextResponse.json({ error: "start and end required" }, { status: 400 });
  }

  try {
    const supabase = createSupabaseAdminClient();
    const result = await backfillLineItemTaxesForRange(supabase, start, end);
    return NextResponse.json(result);
  } catch (err) {
    return apiError(err);
  }
}
