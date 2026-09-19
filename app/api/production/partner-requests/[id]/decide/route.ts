import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { decideRequest, RequestError } from "@/lib/partner/requests.server";

export const dynamic = "force-dynamic";

// POST /api/production/partner-requests/:id/decide
// { action: "approve" | "decline", note?, channel?, recipe_id? }
// Approving writes the commitment (and, for a claim, carves the allocation out
// of the taproom's share) — the same records a brewer would create by hand.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let session;
  try { session = await requirePermission(CAP.partnerRequestsDecide); } catch (res) { return res as Response; }
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  try {
    return NextResponse.json(await decideRequest(createSupabaseAdminClient(), session.user.id, id, body));
  } catch (e) {
    if (e instanceof RequestError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
