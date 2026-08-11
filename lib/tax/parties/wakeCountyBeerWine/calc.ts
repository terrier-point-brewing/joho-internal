/**
 * Wake County — Beer & Wine License renewal — calculation engine.
 *
 *  - computeBeerWineFigures    — pure worksheet builder: one fee line per
 *    selected license type plus their total, straight from the statutory fee
 *    schedule in ./rates.ts.
 *  - computeBeerWineWorksheet  — glue: reads the selected license types out of
 *    `tax_schedules.config.license_types` and hands them to the pure builder.
 *
 * There is nothing to fetch — no Square base, no rate row. The renewal fee is a
 * function of which licenses the brewery holds, and that is schedule config.
 * All money is integer cents; the fees are exact, so nothing rounds.
 */
import type { ComputeContext, WorksheetData, WorksheetFields } from "@/lib/tax/types";
import { BEER_WINE_LICENSE_TYPES, findLicenseType, licenseFeeFieldKey } from "./rates";

/** Reads `config.license_types` as a clean list of known license-type values. */
export function readLicenseTypes(config: Record<string, unknown> | undefined): string[] {
  const raw = config?.license_types;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    const value = String(entry);
    if (seen.has(value) || !findLicenseType(value)) continue;
    seen.add(value);
    out.push(value);
  }
  // Render in the county's published order, not the order they were checked.
  return BEER_WINE_LICENSE_TYPES.filter((t) => out.includes(t.value)).map((t) => t.value);
}

export function computeBeerWineFigures(licenseTypes: string[]): WorksheetData {
  const fields: WorksheetFields = {};
  let totalCents = 0;

  for (const type of BEER_WINE_LICENSE_TYPES) {
    const selected = licenseTypes.includes(type.value);
    // null (not 0) for an unheld license — "not applicable", which the
    // worksheet renders as "—" and never sums into the total.
    fields[licenseFeeFieldKey(type.value)] = selected ? type.feeCents : null;
    if (selected) totalCents += type.feeCents;
  }

  fields.wake_bw_license_count = licenseTypes.length;
  fields.wake_bw_total_fee_cents = totalCents;

  const result: WorksheetData = {
    fields,
    meta: { computedAt: new Date().toISOString(), provenance: "schedule_config" },
  };

  if (licenseTypes.length === 0) {
    result.warnings = [
      "No license types selected on this schedule, so the renewal total is $0.00. Edit the schedule (Finance → Tax → Schedules) to select the licenses this brewery holds, then recompute.",
    ];
  }

  return result;
}

export async function computeBeerWineWorksheet(ctx: ComputeContext): Promise<WorksheetData> {
  return computeBeerWineFigures(readLicenseTypes(ctx.schedule.config));
}
