/**
 * Per-authority account/license/registration numbers (`tax_registrations`,
 * see lib/tax/registrations.ts) — a finer grain than `tax_authorities`. GET
 * lists all registrations; PUT (admin-only) fully replaces the set: rows
 * without an id are inserted, rows with an id are updated, and any existing
 * row whose id is absent from the payload is deleted.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import {
  listRegistrations,
  saveRegistrations,
  resolveRequiredRegistrations,
  BASE_REQUIRED_REGISTRATIONS,
  type TaxRegistrationInput,
} from "@/lib/tax/registrations";
import { listActivePartyKeys } from "@/lib/tax/schedules";
import { getParty, listParties } from "@/lib/tax/registry";
// Side-effect import: registers every party template before getParty() runs.
import "@/lib/tax/parties";

export const dynamic = "force-dynamic";

export async function GET() {
  try { await requirePermission(CAP.taxRead); } catch (res) { return res as Response; }

  try {
    const sb = createSupabaseAdminClient();
    const [registrations, activePartyKeys] = await Promise.all([
      listRegistrations(sb),
      listActivePartyKeys(sb),
    ]);
    // Defensive: an active tax_schedules row can outlive the party template
    // it references (e.g. a party removed from code) — skip unregistered
    // keys rather than let getParty() throw and 500 the whole settings page.
    const registeredKeys = new Set(listParties().map((p) => p.key));
    const requirements = [
      ...BASE_REQUIRED_REGISTRATIONS,
      ...activePartyKeys.filter((key) => registeredKeys.has(key)).flatMap((key) => getParty(key).requiredRegistrations),
    ];
    const required = resolveRequiredRegistrations(requirements, registrations);
    return NextResponse.json({ registrations, required });
  } catch (err) {
    return apiError(err);
  }
}

export async function PUT(req: NextRequest) {
  try { await requirePermission(CAP.taxManage); } catch (res) { return res as Response; }

  try {
    const body = (await req.json()) as TaxRegistrationInput[] | { rows: TaxRegistrationInput[] };
    const rows = Array.isArray(body) ? body : body.rows;
    if (!Array.isArray(rows)) return apiError(new Error("rows is required"), 400);
    for (const row of rows) {
      if (!row || typeof row.authority_key !== "string" || !row.authority_key.trim()) {
        return apiError(new Error("each registration requires an authority_key"), 400);
      }
      if (typeof row.label !== "string" || !row.label.trim()) {
        return apiError(new Error("each registration requires a label"), 400);
      }
    }
    const sb = createSupabaseAdminClient();
    await saveRegistrations(sb, rows);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}
