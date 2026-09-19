import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requirePartner } from "@/lib/partner/portal.server";
import { RequestError, withdrawRequest } from "@/lib/partner/requests.server";

export const dynamic = "force-dynamic";

// DELETE /api/partner/requests/:id — withdraw, while it is still undecided.
// Nothing is deleted: the row stays, marked withdrawn.
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let caller;
  try { caller = await requirePartner(req); } catch (res) { return res as Response; }
  if (caller.preview) return NextResponse.json({ error: "Preview mode cannot withdraw requests." }, { status: 403 });
  const { id } = await params;
  try {
    await withdrawRequest(createSupabaseAdminClient(), caller.partnerId, id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof RequestError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
