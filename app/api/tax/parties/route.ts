/**
 * Registry metadata for every registered tax party template — powers the
 * "add schedule" / worksheet UI (which parties exist, what frequencies they
 * support, their settings/schedule-config field specs, and their reference
 * tables). No filing data lives here; read-gated the same as the rest of the
 * tax module's GETs (manager+).
 */
import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { listParties } from "@/lib/tax/registry";
import { buildRateMap, listTaxRates } from "@/lib/tax/rates";
// Side-effect import: registers every party template before listParties() runs.
import "@/lib/tax/parties";

export const dynamic = "force-dynamic";

export async function GET() {
  try { await requireRole(["manager"]); } catch (res) { return res as Response; }

  try {
    const sb = createSupabaseAdminClient();
    const rateMap = buildRateMap(await listTaxRates(sb));
    const parties = listParties().map((party) => ({
      key: party.key,
      label: party.label,
      supportedFrequencies: party.supportedFrequencies,
      settingsSchema: party.settingsSchema,
      scheduleConfigSchema: party.scheduleConfigSchema,
      referenceView: party.buildReferenceView(rateMap),
      recomputeLabel: party.recomputeLabel,
      worksheetComponent: party.worksheetComponent,
      defaultDueRules: Object.fromEntries(
        party.supportedFrequencies.map((f) => [f, party.defaultDueRule(f)]),
      ),
    }));
    return NextResponse.json(parties);
  } catch (err) {
    return apiError(err);
  }
}
