import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * GET — refunds against an invoice that nobody has explained yet.
 *
 * The predicate IS the alert: `reason_code is null` and `invoice_id is not
 * null`. There is no alert table, no queue, and nothing to mark as read — a
 * refund leaves this list by being classified, which is the work itself.
 *
 * Taproom POS refunds never appear here. They have no invoice, the single
 * contra account is the right posting for them, and there is nothing about
 * inventory or excise for a human to decide.
 */
export async function GET(_req: NextRequest) {
  try { await requirePermission(CAP.exportOperate); } catch (res) { return res as Response; }

  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("square_refunds")
    .select("id, amount_cents, reason, refunded_at, status, invoice_id, invoices(invoice_number, customer_name, invoice_type)")
    .is("reason_code", null)
    .not("invoice_id", "is", null)
    .order("refunded_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ refunds: data ?? [] });
}
