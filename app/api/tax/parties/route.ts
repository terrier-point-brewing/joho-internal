/**
 * Registry metadata for every registered tax party template — powers the
 * "add schedule" / worksheet UI (which parties exist, what frequencies they
 * support, their settings/schedule-config field specs, and their reference
 * tables). No filing data lives here; read-gated the same as the rest of the
 * tax module's GETs (manager+).
 */
import { NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { listParties } from "@/lib/tax/registry";
import { buildRateMap, listTaxRates } from "@/lib/tax/rates";
import { listRegistrations, resolveRequiredRegistrations, BASE_REQUIRED_REGISTRATIONS } from "@/lib/tax/registrations";
// Side-effect import: registers every party template before listParties() runs.
import "@/lib/tax/parties";

export const dynamic = "force-dynamic";

export async function GET() {
  try { await requirePermission(CAP.taxRead); } catch (res) { return res as Response; }

  try {
    const sb = createSupabaseAdminClient();
    const [rateMap, registrations] = await Promise.all([
      listTaxRates(sb).then(buildRateMap),
      listRegistrations(sb),
    ]);
    const parties = listParties().map((party) => ({
      key: party.key,
      label: party.label,
      supportedFrequencies: party.supportedFrequencies,
      settingsSchema: party.settingsSchema,
      scheduleConfigSchema: party.scheduleConfigSchema,
      // Party-specific registrations first, the universal FEIN last — the
      // worksheet header renders this order, and the party's own account and
      // permit numbers are what a filer looks for first. Any entry declaring
      // `identityOrder` is sorted ahead of the rest client-side.
      requiredRegistrations: resolveRequiredRegistrations(
        [...party.requiredRegistrations, ...BASE_REQUIRED_REGISTRATIONS],
        registrations,
      ),
      referenceView: party.buildReferenceView(rateMap),
      recomputeLabel: party.recomputeLabel,
      worksheetComponent: party.worksheetComponent,
      defaultDueRules: Object.fromEntries(
        party.supportedFrequencies.map((f) => [f, party.defaultDueRule(f)]),
      ),
      // The party's CURRENT period per frequency. The schedule editor previews
      // a due date against these instead of a hardcoded calendar quarter —
      // Wake County's beer & wine periods end April 30, so "a period ending
      // 2026-12-31" was a preview of a period that party never produces.
      samplePeriods: Object.fromEntries(
        party.supportedFrequencies.map((f) => {
          const period = party.computePeriod(f, new Date());
          return [f, { start: period.start, end: period.end }];
        }),
      ),
    }));
    return NextResponse.json(parties);
  } catch (err) {
    return apiError(err);
  }
}
