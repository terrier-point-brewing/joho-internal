/**
 * NC DOR Beer Excise (Form B-C-710) — shipments compute engine.
 *
 * Three pieces:
 *  - `fetchExciseData`         — pulls per-channel gallons and the NC excise
 *    detail already stored on `export_transactions`/`export_transaction_taxes`
 *    for the period, plus a count of taxable rows missing that detail.
 *    Injectable `sb` so it's testable with a stub.
 *  - `fetchNcRateMicros`       — reads the active NC rate from the canonical
 *    `tax_rates` row (key `nc_dor_beer_excise`) via the shared accessor;
 *    `null` when absent/invalid (caller falls back to the statutory constant).
 *  - `computeBeerExciseFigures`— pure worksheet builder: maps channel gallons
 *    onto the Line 2–11 waterfall (via the shared `deriveBeerExciseFigures`)
 *    and flags rate-drift / missing-detail-coverage warnings.
 *  - `computeBeerExciseWorksheet` — glue: resolves the period, fetches the
 *    above, and assembles the initial field set.
 *
 * All money is integer cents. Gallons are integers. Every rounding uses
 * `Math.round` exactly once at its point of definition.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { addDaysStr } from "@/lib/utils/datetime";
import { GALLONS_PER_BBL } from "@/lib/constants/production";
import type { ComputeContext, TaxPeriod, WorksheetData, WorksheetFields } from "@/lib/tax/types";
import { NC_EXCISE_RATE_MICROS_FALLBACK, TAXABLE_CHANNELS, WHOLESALE_CHANNEL, usdToMicros } from "./rates";
import { deriveBeerExciseFigures } from "./derive";
import { getTaxRate, TAX_RATE_KEYS } from "@/lib/tax/rates";

const num = (v: number | string | null | undefined) => Number(v ?? 0);

export interface ExciseDataResult {
  gallonsByChannel: Record<string, number>;
  storedNcCents: number;
  missingDetailTxns: number;
}

interface ExportTaxDetailRow {
  tax_name: string;
  amount_usd: number | string | null;
}

interface ExportRow {
  channel: string;
  volume_bbl: number | string;
  export_transaction_taxes: ExportTaxDetailRow[] | ExportTaxDetailRow | null;
}

/**
 * Pull the period's per-channel gallons plus the NC excise detail already
 * recorded on each taxable row (so `computeBeerExciseFigures` can flag a
 * drift between the recomputed L6 and what was actually invoiced/collected).
 *
 * `created_at` is the ship/record date: range is
 * `[start 00:00Z, dayAfter(end) 00:00Z)` so the whole final calendar day is
 * included.
 */
export async function fetchExciseData(sb: SupabaseClient, period: TaxPeriod): Promise<ExciseDataResult> {
  const startTs = `${period.start}T00:00:00Z`;
  const endExclusiveTs = `${addDaysStr(period.end, 1)}T00:00:00Z`;

  const { data, error } = await sb
    .from("export_transactions")
    .select("channel, volume_bbl, export_transaction_taxes ( tax_name, amount_usd )")
    .gte("created_at", startTs)
    .lt("created_at", endExclusiveTs);

  if (error) throw new Error(error.message);

  const gallonsByChannel: Record<string, number> = {};
  const bblByChannel: Record<string, number> = {};
  let storedNcDollars = 0;
  let missingDetailTxns = 0;

  for (const row of (data ?? []) as ExportRow[]) {
    const bbl = num(row.volume_bbl);
    bblByChannel[row.channel] = (bblByChannel[row.channel] ?? 0) + bbl;

    if (!TAXABLE_CHANNELS.has(row.channel)) continue;

    const detailRaw = row.export_transaction_taxes;
    const details = Array.isArray(detailRaw) ? detailRaw : detailRaw ? [detailRaw] : [];
    const ncDetails = details.filter((d) => d.tax_name != null && /\bnc\b/i.test(d.tax_name));

    if (ncDetails.length > 0) {
      for (const d of ncDetails) storedNcDollars += num(d.amount_usd);
    } else if (bbl > 0) {
      missingDetailTxns += 1;
    }
  }

  for (const [channel, bbl] of Object.entries(bblByChannel)) {
    gallonsByChannel[channel] = Math.round(bbl * GALLONS_PER_BBL);
  }

  return {
    gallonsByChannel,
    storedNcCents: Math.round(storedNcDollars * 100),
    missingDetailTxns,
  };
}

/**
 * Read the active NC beer-excise rate from the canonical `tax_rates` row
 * (key `nc_dor_beer_excise`) via the shared `getTaxRate` accessor. Returns
 * `null` (never throws) when no active row exists, or when its `rate` is not
 * a finite positive number, so the caller can fall back to the statutory
 * constant.
 */
export async function fetchNcRateMicros(sb: SupabaseClient): Promise<number | null> {
  const rateUsd = await getTaxRate(sb, TAX_RATE_KEYS.NC_DOR_BEER_EXCISE);
  if (rateUsd == null) return null;
  if (!Number.isFinite(rateUsd) || rateUsd <= 0) return null;
  return usdToMicros(rateUsd);
}

export interface ComputeBeerExciseFiguresArgs {
  gallonsByChannel: Record<string, number>;
  ncRateMicros: number;
  storedNcCents: number;
  missingDetailTxns: number;
}

/**
 * Pure worksheet builder. Maps channel gallons onto the Line 2–11 waterfall
 * via the shared `deriveBeerExciseFigures`, then flags:
 *  - rate drift: computed L6 vs. what was actually stored/invoiced
 *    (tolerance = max(100¢, 0.1% of storedNcCents) — can indicate a stale
 *    configured rate or missing excise detail; review before filing).
 *  - coverage: taxable rows missing NC excise detail, which should be
 *    backfilled before filing.
 */
export function computeBeerExciseFigures(args: ComputeBeerExciseFiguresArgs): WorksheetData {
  const { gallonsByChannel, ncRateMicros, storedNcCents, missingDetailTxns } = args;
  const warnings: string[] = [];

  const fields: WorksheetFields = {
    gal_distribution: gallonsByChannel.distribution ?? 0,
    gal_contract: gallonsByChannel.contract_brewing ?? 0,
    gal_taproom: gallonsByChannel.taproom ?? 0,
    gal_wholesale: gallonsByChannel[WHOLESALE_CHANNEL] ?? 0,
    gal_beginning_inventory: 0,
    gal_deduction_other: 0,
    gal_adjustments_part3: 0,
    gal_military_part4: 0,
    gal_ending_inventory: 0,
    nc_excise_rate_micros: ncRateMicros,
    flag_timely: 1,
    flag_amended: 0,
    flag_no_transactions: 0,
    signer_date: "",
    cents_penalty: 0,
    cents_interest: 0,
  };

  const derived = deriveBeerExciseFigures(fields);

  const centsExciseDue = num(derived.cents_excise_due);
  const tolerance = Math.max(100, Math.round(storedNcCents * 0.001));
  const diff = Math.abs(centsExciseDue - storedNcCents);
  if (diff > tolerance) {
    warnings.push(
      `Computed excise due (${centsExciseDue}¢) differs from stored/invoiced NC excise (${storedNcCents}¢) by ${diff}¢, exceeding the ${tolerance}¢ tolerance, which can indicate a stale configured rate or missing excise detail — review before filing.`,
    );
  }

  if (missingDetailTxns > 0) {
    warnings.push(
      `${missingDetailTxns} taxable shipment${missingDetailTxns === 1 ? "" : "s"} missing NC excise detail — backfill excise detail before filing.`,
    );
  }

  const result: WorksheetData = {
    fields: derived,
    meta: { computedAt: new Date().toISOString(), provenance: "export_transactions" },
  };
  if (warnings.length > 0) result.warnings = warnings;
  return result;
}

/**
 * Compute the beer excise worksheet for a filing period. Reads shipments
 * gallons from `export_transactions` and the live NC rate from the canonical
 * `tax_rates` row (key `nc_dor_beer_excise`), falling back to the statutory
 * constant if that row is missing.
 *
 * `sb` defaults to the service-role admin client; it's injectable so this is
 * testable without a live DB.
 */
export async function computeBeerExciseWorksheet(
  ctx: ComputeContext,
  sb?: SupabaseClient,
): Promise<WorksheetData> {
  const client = sb ?? (await import("@/lib/supabase/admin")).createSupabaseAdminClient();

  const [data, fetchedMicros] = await Promise.all([
    fetchExciseData(client, ctx.period),
    fetchNcRateMicros(client),
  ]);

  const warnings: string[] = [];
  const micros = fetchedMicros ?? NC_EXCISE_RATE_MICROS_FALLBACK;
  if (fetchedMicros == null) {
    warnings.push(
      "No active NC excise-tax gallon rate configured — using the statutory fallback ($0.6171/gal). Set the rate in Finance > Settings > Excise Tax.",
    );
  }

  const computed = computeBeerExciseFigures({
    gallonsByChannel: data.gallonsByChannel,
    ncRateMicros: micros,
    storedNcCents: data.storedNcCents,
    missingDetailTxns: data.missingDetailTxns,
  });

  const allWarnings = [...warnings, ...(computed.warnings ?? [])];
  const result: WorksheetData = { ...computed };
  if (allWarnings.length > 0) result.warnings = allWarnings;
  else delete result.warnings;
  return result;
}
