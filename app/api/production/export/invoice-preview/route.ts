import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { buildInvoicePreview } from "@/lib/production/exportInvoicePreview";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try { await requirePermission(CAP.exportOperate); } catch (res) { return res as Response; }

  const idsParam = req.nextUrl.searchParams.get("ids");
  const ids = idsParam ? idsParam.split(",").filter(Boolean) : [];
  const billAs = req.nextUrl.searchParams.get("billAs");
  if (billAs && !["distribution", "contract_brewing", "wholesale"].includes(billAs)) {
    return NextResponse.json({ error: "billAs must be distribution | contract_brewing | wholesale" }, { status: 400 });
  }

  const supabase = createSupabaseAdminClient();
  try {
    const preview = await buildInvoicePreview(supabase, ids, billAs);
    return NextResponse.json(preview);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
