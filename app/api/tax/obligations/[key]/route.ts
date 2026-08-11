/**
 * One filing obligation's mutable settings — today just `filing_url`, the
 * authority portal link edited under Settings → Tax Filing.
 *
 * PATCH only: an obligation row is created by migration beside its
 * `TaxPartyTemplate` (see lib/tax/obligations.test.ts), so there is
 * deliberately no POST/DELETE here — a row without a template throws at
 * `getParty()`, and a UI must not be able to make one.
 *
 * Reads of `filing_url` go through `GET /api/tax/parties`, which already
 * serves every other piece of per-module metadata the screens need.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { setFilingUrl, validateFilingUrl } from "@/lib/tax/obligations";
import { getParty } from "@/lib/tax/registry";
// Side-effect import: registers every party template before getParty() runs.
import "@/lib/tax/parties";

export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  try { await requirePermission(CAP.taxFilingManage); } catch (res) { return res as Response; }

  const { key } = await params;
  try {
    // Throws for an unregistered key before we touch the row — the same guard
    // the profiles route uses.
    getParty(key);

    const body = (await req.json()) as { filing_url?: string | null };
    const msg = validateFilingUrl(body.filing_url);
    if (msg) return apiError(msg, 400);

    const sb = createSupabaseAdminClient();
    const obligation = await setFilingUrl(sb, key, body.filing_url?.trim() || null);
    return NextResponse.json(obligation);
  } catch (err) {
    return apiError(err);
  }
}
