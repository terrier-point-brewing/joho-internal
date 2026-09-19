import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { loadPartnerLedger } from "@/lib/production/partnerLedger.server";
import { loadPartnerExcise, requirePartner, toPortalHistory } from "@/lib/partner/portal.server";

export const dynamic = "force-dynamic";

// GET /api/partner/history — the partner's own deals and shipments, read from
// the same ledger staff use and cut down to what a partner may see.
export async function GET(req: NextRequest) {
  let caller;
  try { caller = await requirePartner(req); } catch (res) { return res as Response; }
  const admin = createSupabaseAdminClient();
  const [ledger, excise] = await Promise.all([loadPartnerLedger(admin), loadPartnerExcise(admin, caller.partnerId)]);
  return NextResponse.json(toPortalHistory(ledger.find((p) => p.partner_id === caller.partnerId), excise));
}
