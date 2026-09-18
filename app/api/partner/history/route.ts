import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { loadPartnerLedger } from "@/lib/production/partnerLedger.server";
import { requirePartner, toPortalHistory } from "@/lib/partner/portal.server";

export const dynamic = "force-dynamic";

// GET /api/partner/history — the partner's own deals and shipments, read from
// the same ledger staff use and cut down to what a partner may see.
export async function GET(req: NextRequest) {
  let caller;
  try { caller = await requirePartner(req); } catch (res) { return res as Response; }
  const ledger = await loadPartnerLedger(createSupabaseAdminClient());
  return NextResponse.json(toPortalHistory(ledger.find((p) => p.partner_id === caller.partnerId)));
}
