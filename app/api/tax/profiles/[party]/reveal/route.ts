/**
 * Reveals the REAL value of a party's `sensitive` `settingsSchema` fields
 * (SSN/FEIN) — the escape hatch from the write-only masked GET at
 * `../route.ts`. Admin-only (stricter than the masked GET's `manager`
 * floor): unmasking a stored value is a more sensitive action than merely
 * knowing one is on file.
 */
import { NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { getProfile, pickSensitiveValues } from "@/lib/tax/profiles";
import { getParty } from "@/lib/tax/registry";
// Side-effect import: registers every party template before getParty() runs.
import "@/lib/tax/parties";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ party: string }> }) {
  try { await requirePermission(CAP.taxPiiReveal); } catch (res) { return res as Response; }

  const { party } = await params;
  try {
    const template = getParty(party);
    const sb = createSupabaseAdminClient();
    const values = await getProfile(sb, party);
    return NextResponse.json(pickSensitiveValues(values, template.settingsSchema));
  } catch (err) {
    return apiError(err);
  }
}
