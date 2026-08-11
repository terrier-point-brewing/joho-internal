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
  maskRegistrations,
  maskResolvedRegistrations,
  preserveBlankSensitiveNumbers,
  sensitiveRegistrationKinds,
  BASE_REQUIRED_REGISTRATIONS,
  type RequiredRegistration,
  type TaxRegistrationInput,
} from "@/lib/tax/registrations";
import { listActivePartyKeys } from "@/lib/tax/schedules";
import { getParty, listParties } from "@/lib/tax/registry";
// Side-effect import: registers every party template before getParty() runs.
import "@/lib/tax/parties";

export const dynamic = "force-dynamic";

/**
 * Which registration kinds are credentials, across EVERY registered party —
 * deliberately not just the ones with an active schedule. Sensitivity is a
 * property of the kind, so deactivating a schedule must never unmask a stored
 * PIN.
 */
function allSensitiveKinds(): Set<string> {
  const requirements: RequiredRegistration[] = [
    ...BASE_REQUIRED_REGISTRATIONS,
    ...listParties().flatMap((p) => p.requiredRegistrations),
  ];
  return sensitiveRegistrationKinds(requirements);
}

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
    // Credentials (Wake County's PIN) leave here as "present"/"absent" only —
    // the real digits come from the admin-only ./reveal route.
    const sensitiveKinds = allSensitiveKinds();
    return NextResponse.json({
      registrations: maskRegistrations(registrations, sensitiveKinds),
      required: maskResolvedRegistrations(required),
    });
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
    // The UI never holds a sensitive registration's real digits, so a blank
    // one means "leave unchanged", not "clear it" (same contract as
    // putProfile's masked fields).
    const existing = await listRegistrations(sb);
    await saveRegistrations(sb, preserveBlankSensitiveNumbers(rows, existing, allSensitiveKinds()));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}
