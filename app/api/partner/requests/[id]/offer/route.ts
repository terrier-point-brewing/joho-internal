import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requirePartner } from "@/lib/partner/portal.server";
import { answerOffer, RequestError } from "@/lib/partner/requests.server";

export const dynamic = "force-dynamic";

// POST /api/partner/requests/:id/offer { action: "accept" | "rescind" }
// The partner's answer to an adjusted share. Accepting sends the request back
// to the brewery at the offered share; rescinding withdraws it.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let caller;
  try { caller = await requirePartner(req); } catch (res) { return res as Response; }
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  try {
    await answerOffer(createSupabaseAdminClient(), caller.partnerId, id, caller.session.user.id, body.action);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof RequestError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
