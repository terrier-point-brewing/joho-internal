import { NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { loadPartnerLedger } from "@/lib/production/partnerLedger.server";

export const dynamic = "force-dynamic";

// GET /api/production/partner-ledger
// Every partner's commitments end to end: booked → allocated → deposit →
// shipped → invoiced → remaining. lib/production/partnerLedger.server loads the
// rows; lib/production/partnerLedger shapes them. Admin client: `invoices` and
// `allocation_deposit_charges` sit in the admin-only RLS cluster, and the
// exportRead gate above is the authorization — same pattern as the
// deposit-invoices route.
export async function GET() {
  try { await requirePermission(CAP.exportRead); } catch (res) { return res as Response; }
  return NextResponse.json(await loadPartnerLedger(createSupabaseAdminClient()));
}
