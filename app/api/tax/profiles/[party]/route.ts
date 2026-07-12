/**
 * Per-party filing profile (contact info, FEIN/SSN, account IDs, ...).
 *
 * GET returns the profile with `sensitive` schema fields masked to
 * `"present"`/`"absent"` — the raw SSN/FEIN never leaves the server. PUT is
 * admin-only and merges submitted values onto the stored profile (blank =
 * leave unchanged, see lib/tax/profiles.ts), so a masked round-trip from the
 * UI can't wipe a stored sensitive value.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { getProfile, putProfile, maskSensitive } from "@/lib/tax/profiles";
import { getParty } from "@/lib/tax/registry";
// Side-effect import: registers every party template before getParty() runs.
import "@/lib/tax/parties";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ party: string }> }) {
  try { await requireRole(["manager"]); } catch (res) { return res as Response; }

  const { party } = await params;
  try {
    const template = getParty(party);
    const sb = createSupabaseAdminClient();
    const values = await getProfile(sb, party);
    return NextResponse.json(maskSensitive(values, template.settingsSchema));
  } catch (err) {
    return apiError(err);
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ party: string }> }) {
  try { await requireRole([]); } catch (res) { return res as Response; }

  const { party } = await params;
  try {
    // Validates the party exists before writing a profile row for it.
    getParty(party);
    const body = (await req.json()) as Record<string, string>;
    const sb = createSupabaseAdminClient();
    await putProfile(sb, party, body);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}
