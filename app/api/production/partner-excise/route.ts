import { NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { EXCISE_LINE_CATEGORY, excisePerPartner, type ExciseInvoice, type ExciseLine } from "@/lib/production/partnerExcise";

export const dynamic = "force-dynamic";

// GET /api/production/partner-excise → { [partner_id]: { charged_cents, collected_cents, … } }
// Admin client: invoices and their lines are in the admin-only RLS cluster, and
// the exportRead gate is the authorization — same pattern as the partner ledger.
export async function GET() {
  try { await requirePermission(CAP.exportRead); } catch (res) { return res as Response; }

  const admin = createSupabaseAdminClient();
  const { data: invoices, error } = await admin.from("invoices")
    .select("id, partner_id, status").eq("invoice_type", "export_invoice").not("partner_id", "is", null);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const ids = ((invoices ?? []) as ExciseInvoice[]).map((i) => i.id);
  const lines: ExciseLine[] = [];
  // Chunked: an .in() list rides in the URL, and a few hundred uuids overflow it.
  for (let i = 0; i < ids.length; i += 150) {
    const { data, error: lineErr } = await admin.from("invoice_line_items")
      .select("invoice_id, total_cents").eq("category", EXCISE_LINE_CATEGORY).in("invoice_id", ids.slice(i, i + 150));
    if (lineErr) return NextResponse.json({ error: lineErr.message }, { status: 500 });
    lines.push(...((data ?? []) as ExciseLine[]));
  }
  return NextResponse.json(excisePerPartner((invoices ?? []) as ExciseInvoice[], lines));
}
