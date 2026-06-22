import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { buildInvoicePreview } from "@/lib/production/exportInvoicePreview";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try { await requireRole(["brewer"]); } catch (res) { return res as Response; }

  const idsParam = req.nextUrl.searchParams.get("ids");
  const ids = idsParam ? idsParam.split(",").filter(Boolean) : [];

  const supabase = createSupabaseAdminClient();
  try {
    const preview = await buildInvoicePreview(supabase, ids);
    return NextResponse.json(preview);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
