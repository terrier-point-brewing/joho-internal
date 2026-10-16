import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { decideRequest, partnerEmails, RequestError, shareOf } from "@/lib/partner/requests.server";
import { renderOfferEmail } from "@/lib/partner/offerEmail";
import { sendEmail } from "@/lib/resend";

export const dynamic = "force-dynamic";

// POST /api/production/partner-requests/:id/decide
// { action: "approve" | "decline" | "adjust", note?, channel?, recipe_id?, share_pct? }
// Approving writes the commitment (and, for a claim, carves the allocation out
// of the taproom's share) — the same records a brewer would create by hand.
// Adjusting counters with a different share and emails the partner's logins.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let session;
  try { session = await requirePermission(CAP.partnerRequestsDecide); } catch (res) { return res as Response; }
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  try {
    const admin = createSupabaseAdminClient();
    const result = await decideRequest(admin, session.user.id, id, body);
    let emailed = 0;
    if (result.offer) {
      const o = result.offer;
      const [{ data: partner }, { data: before }] = await Promise.all([
        admin.from("contract_brewing_partners").select("company_name").eq("id", o.partner_id).maybeSingle(),
        admin.from("partner_requests").select("wanted_bbl, share_pct").eq("id", id).maybeSingle(),
      ]);
      const asked = Number(before?.wanted_bbl ?? o.brew_bbl);
      const { subject, html } = renderOfferEmail({
        company_name: partner?.company_name ?? "there", beer_name: o.beer_name, turns: o.turns, brew_bbl: o.brew_bbl,
        asked_bbl: asked, asked_pct: Number(before?.share_pct ?? shareOf(asked, o.brew_bbl)),
        offered_bbl: o.bbl, offered_pct: o.pct, note: o.note,
      });
      // The offer is saved either way; a mail that fails is reported, not fatal.
      for (const to of await partnerEmails(admin, o.partner_id)) {
        try { await sendEmail(to, subject, html); emailed++; } catch (e) { console.error("partner offer email failed", to, e); }
      }
    }
    return NextResponse.json({ ...result, emailed });
  } catch (e) {
    if (e instanceof RequestError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
