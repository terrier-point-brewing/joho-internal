/**
 * NC DOR Beer Excise (Form B-C-710, with its B-C-715 shipping report) —
 * shipments compute engine.
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
import { fetchAllRows } from "@/lib/supabase/paginate";
import { addDaysStr, dayEndUtc } from "@/lib/utils/datetime";
import { GALLONS_PER_BBL } from "@/lib/constants/production";
import type { ComputeContext, TaxPeriod, WorksheetData, WorksheetFields } from "@/lib/tax/types";
import { NC_EXCISE_RATE_MICROS_FALLBACK, TAXABLE_CHANNELS, WHOLESALE_CHANNEL, usdToMicros } from "./rates";
import { deriveBeerExciseFigures } from "./derive";
import { SHIPPING_REPORT_FIELD, buildShippingReportLines, type ShippingReportRow } from "./shippingReport";
import { getTaxRate, TAX_RATE_KEYS } from "@/lib/tax/rates";

const num = (v: number | string | null | undefined) => Number(v ?? 0);

/**
 * True when `now` is at or before the brewery-local end of `dueDate` — the
 * "return + full payment filed timely" condition Form B-C-710 Line 7's 2%
 * discount depends on. No longer a manual checkbox: it's decided
 * automatically from the current date vs. the filing period's due date
 * every time the worksheet is (re)computed. `now` is injectable for tests.
 */
export function isFiledTimely(dueDate: string, now: Date = new Date()): boolean {
  return now.getTime() <= new Date(dayEndUtc(dueDate)).getTime();
}

export interface ExciseDataResult {
  gallonsByChannel: Record<string, number>;
  storedNcCents: number;
  missingDetailTxns: number;
  /** Wholesale shipments, one per export row — the B-C-715 shipping report's source. */
  wholesaleShipments: ShippingReportRow[];
}

interface ExportTaxDetailRow {
  tax_name: string;
  amount_usd: number | string | null;
}

interface ExportRow {
  channel: string;
  volume_bbl: number | string;
  export_transaction_taxes: ExportTaxDetailRow[] | ExportTaxDetailRow | null;
  id?: string;
  shipment_id?: string | null;
  invoice_id?: string | null;
  created_at?: string | null;
  recipient_name?: string | null;
  invoices?: InvoiceJoin | InvoiceJoin[] | null;
  contract_brewing_partners?: PartnerJoin | PartnerJoin[] | null;
}

interface InvoiceJoin {
  invoice_number: string | null;
  invoice_date: string | null;
  customer_name: string | null;
}

interface PartnerJoin {
  company_name: string | null;
  address: string | null;
}

/** PostgREST returns a to-one embed as an object, but the generated types allow an array. */
function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
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

  // Paginated for the same reason as the federal return's removal read: an
  // unpaginated select silently stops at PostgREST's default row cap, and a
  // return short of its tail looks exactly like a quiet month.
  const data = await fetchAllRows<ExportRow>(() =>
    sb
      .from("export_transactions")
      .select(
        "id, channel, volume_bbl, shipment_id, invoice_id, created_at, recipient_name, export_transaction_taxes ( tax_name, amount_usd ), invoices ( invoice_number, invoice_date, customer_name ), contract_brewing_partners ( company_name, address )",
      )
      .gte("created_at", startTs)
      .lt("created_at", endExclusiveTs)
      .order("id", { ascending: true }),
  );

  const gallonsByChannel: Record<string, number> = {};
  const bblByChannel: Record<string, number> = {};
  let storedNcDollars = 0;
  let missingDetailTxns = 0;
  const wholesaleShipments: ShippingReportRow[] = [];

  for (const row of data) {
    const bbl = num(row.volume_bbl);
    bblByChannel[row.channel] = (bblByChannel[row.channel] ?? 0) + bbl;

    if (row.channel === WHOLESALE_CHANNEL) {
      const invoice = one(row.invoices);
      const partner = one(row.contract_brewing_partners);
      wholesaleShipments.push({
        groupKey: row.invoice_id ?? row.shipment_id ?? row.id ?? String(wholesaleShipments.length),
        shippedAt: row.created_at ?? startTs,
        invoiceDate: invoice?.invoice_date ?? null,
        invoiceNumber: invoice?.invoice_number ?? null,
        name: partner?.company_name ?? invoice?.customer_name ?? row.recipient_name ?? null,
        address: partner?.address ?? null,
        volumeBbl: bbl,
      });
    }

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
    wholesaleShipments,
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
  filedTimely: boolean;
  /** Omitted → an empty B-C-715 (no wholesale shipments). */
  wholesaleShipments?: ShippingReportRow[];
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
  const { gallonsByChannel, ncRateMicros, storedNcCents, missingDetailTxns, filedTimely } = args;
  const warnings: string[] = [];

  const shippingLines = buildShippingReportLines(args.wholesaleShipments ?? [], gallonsByChannel[WHOLESALE_CHANNEL] ?? 0);

  const fields: WorksheetFields = {
    gal_distribution: gallonsByChannel.distribution ?? 0,
    gal_contract: gallonsByChannel.contract_brewing ?? 0,
    gal_taproom: gallonsByChannel.taproom ?? 0,
    gal_wholesale: gallonsByChannel[WHOLESALE_CHANNEL] ?? 0,
    [SHIPPING_REPORT_FIELD]: JSON.stringify(shippingLines),
    gal_beginning_inventory: 0,
    gal_deduction_other: 0,
    gal_adjustments_part3: 0,
    gal_military_part4: 0,
    gal_ending_inventory: 0,
    nc_excise_rate_micros: ncRateMicros,
    flag_timely: filedTimely ? 1 : 0,
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

  const incomplete = shippingLines.filter((l) => !l.invoiceNumber || !l.name || !l.address).length;
  if (incomplete > 0) {
    warnings.push(
      `${incomplete} wholesale shipment${incomplete === 1 ? "" : "s"} on the B-C-715 shipping report ${incomplete === 1 ? "is" : "are"} missing an invoice number, wholesaler name or address — complete ${incomplete === 1 ? "it" : "them"} before filing.`,
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
  now: Date = new Date(),
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
    filedTimely: isFiledTimely(ctx.period.due, now),
    wholesaleShipments: data.wholesaleShipments,
  });

  const allWarnings = [...warnings, ...(computed.warnings ?? [])];
  const result: WorksheetData = { ...computed };
  if (allWarnings.length > 0) result.warnings = allWarnings;
  else delete result.warnings;
  return result;
}
