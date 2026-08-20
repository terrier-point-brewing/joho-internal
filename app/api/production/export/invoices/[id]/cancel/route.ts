import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSessionUser } from "@/lib/auth/session";
import { cancelExportInvoice, CancelInvoiceError } from "@/lib/finance/cancelInvoice";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * POST — cancel this export invoice: kill it in Square, void the ledger row, and
 * return its shipments to the Invoice Required queue.
 *
 * The admin client, not the session client: this writes across `invoices`,
 * `export_transactions` and `invoice_sku_substitutions`, and the finance tables
 * are reader-only to the session role (the same reason the refund route uses it).
 * The operator is recorded in the invoice's own `notes`/`voided_reason` instead
 * of by the audit trigger's auth.uid().
 */
export async function POST(req: NextRequest, { params }: RouteParams) {
  try { await requirePermission(CAP.exportOperate); } catch (res) { return res as Response; }

  const { id } = await params;

  let body: { reason?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const supabase = createSupabaseAdminClient();
  const user = await getSessionUser();

  try {
    const result = await cancelExportInvoice(supabase, {
      invoiceId: id,
      reason: body.reason ?? "",
      userId: user?.user.email ?? user?.user.id ?? null,
    });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof CancelInvoiceError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Cancel failed" },
      { status: 500 },
    );
  }
}
