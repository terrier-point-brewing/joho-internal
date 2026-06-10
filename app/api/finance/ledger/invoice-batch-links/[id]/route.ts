import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

// ── DELETE /api/finance/ledger/invoice-batch-links/[id] ──────────────────────
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try { await requireRole("admin"); } catch (res) { return res as Response; }

  const { id } = await params;
  const supabase = createSupabaseAdminClient();

  const { error } = await supabase
    .from("invoice_batch_links")
    .delete()
    .eq("id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
