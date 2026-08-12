/**
 * TTB F 5130.Pilot-B — shipments compute engine.
 *
 * Four pieces:
 *  - `fetchRemovalData`    — pulls per-channel barrels for the filing period,
 *    plus calendar-year-to-date barrels through the period end (needed only to
 *    police the 60,000 bbl reduced-rate ceiling). Injectable `sb` so it's
 *    testable with a stub.
 *  - `fetchTtbRateMicros`  — reads the active federal rate from the canonical
 *    `tax_rates` row (key `federal_beer_excise`); `null` when absent/invalid,
 *    so the caller falls back to the statutory $3.50.
 *  - `computeTtbFigures`   — pure worksheet builder: maps channel barrels onto
 *    the form via the shared `deriveTtbFigures` and raises the guards that
 *    protect this brewery's simplifying assumptions.
 *  - `computeTtbWorksheet` — glue: resolves the period, fetches the above, and
 *    assembles the initial field set.
 *
 * Barrels come straight off `export_transactions.volume_bbl` — no conversion,
 * so nothing is lost the way it would be through a gallons round-trip. Money
 * is integer cents.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { addDaysStr } from "@/lib/utils/datetime";
import type { ComputeContext, TaxPeriod, WorksheetData, WorksheetFields } from "@/lib/tax/types";
import { getTaxRate, TAX_RATE_KEYS } from "@/lib/tax/rates";
import {
  SCHEDULE_A_ROWS,
  TTB_REDUCED_RATE_MICROS_FALLBACK,
  TTB_REDUCED_RATE_USD_FALLBACK,
  TTB_REDUCED_TIER_LIMIT_BBL,
  TTB_TAXABLE_CHANNELS,
  ttbPeriodLabel,
  ttbSerialNumber,
  usdToMicrosPerBbl,
} from "./rates";
import { decreasingRowKeys, deriveTtbFigures, increasingRowKeys, roundBbl } from "./derive";

const num = (v: number | string | null | undefined) => Number(v ?? 0);

export interface RemovalDataResult {
  /** Barrels shipped in the filing period, by `export_transactions.channel`. */
  barrelsByChannel: Record<string, number>;
  /** Barrels shipped from January 1 through the period end — the reduced-rate tier is a calendar-year measure. */
  barrelsYearToDate: number;
  /** Channels seen in the period that this party does not recognize — a silent-omission guard. */
  unknownChannels: string[];
}

interface RemovalRow {
  channel: string;
  volume_bbl: number | string;
}

/**
 * Pull the period's per-channel barrels plus calendar-year-to-date barrels.
 *
 * `created_at` is the ship/record date, matching Form B-C-710's compute: the
 * range is `[start 00:00Z, dayAfter(end) 00:00Z)` so the whole final calendar
 * day is included. Because TTB taxes beer on REMOVAL, ship timing is exactly
 * the right event — this brewery records a taproom sale at the moment stock
 * moves out of the brewery, so no separate transfer feed is needed.
 */
export async function fetchRemovalData(sb: SupabaseClient, period: TaxPeriod): Promise<RemovalDataResult> {
  const endExclusiveTs = `${addDaysStr(period.end, 1)}T00:00:00Z`;
  const yearStartTs = `${period.start.slice(0, 4)}-01-01T00:00:00Z`;

  // Paginated: this spans calendar-year-to-date, not just the filing period,
  // so it outgrows PostgREST's default row cap sooner than a quarter's worth
  // of shipments suggests. An unpaginated read would silently drop the tail
  // and under-report the return with nothing on the form to say so.
  const data = await fetchAllRows<RemovalRow & { created_at: string }>(() =>
    sb
      .from("export_transactions")
      .select("channel, volume_bbl, created_at")
      .gte("created_at", yearStartTs)
      .lt("created_at", endExclusiveTs)
      .order("id", { ascending: true }),
  );

  const periodStartTs = `${period.start}T00:00:00Z`;
  const barrelsByChannel: Record<string, number> = {};
  const unknown = new Set<string>();
  let barrelsYearToDate = 0;

  for (const row of data) {
    const bbl = num(row.volume_bbl);
    barrelsYearToDate += bbl;
    if (row.created_at < periodStartTs) continue;

    barrelsByChannel[row.channel] = (barrelsByChannel[row.channel] ?? 0) + bbl;
    if (!TTB_TAXABLE_CHANNELS.has(row.channel)) unknown.add(row.channel);
  }

  for (const channel of Object.keys(barrelsByChannel)) {
    barrelsByChannel[channel] = roundBbl(barrelsByChannel[channel]);
  }

  return {
    barrelsByChannel,
    barrelsYearToDate: roundBbl(barrelsYearToDate),
    unknownChannels: [...unknown].sort(),
  };
}

/**
 * Read the active federal beer-excise rate from the canonical `tax_rates` row
 * (key `federal_beer_excise`, basis `per_bbl`). Returns `null` (never throws)
 * when no active row exists, or when its `rate` is not a finite positive
 * number, so the caller can fall back to the statutory constant.
 */
export async function fetchTtbRateMicros(sb: SupabaseClient): Promise<number | null> {
  const rateUsd = await getTaxRate(sb, TAX_RATE_KEYS.FEDERAL_BEER_EXCISE);
  if (rateUsd == null) return null;
  if (!Number.isFinite(rateUsd) || rateUsd <= 0) return null;
  return usdToMicrosPerBbl(rateUsd);
}

/** Blank Schedule A rows — the 5 printed on page 1. Continuation sheets are not modelled. */
function blankScheduleA(): WorksheetFields {
  const fields: WorksheetFields = {};
  for (let i = 1; i <= SCHEDULE_A_ROWS; i += 1) {
    const inc = increasingRowKeys(i);
    fields[inc.type] = "";
    fields[inc.info] = "";
    fields[inc.unit] = "barrels";
    fields[inc.quantity] = 0;
    fields[inc.rateMicros] = 0;

    const dec = decreasingRowKeys(i);
    fields[dec.type] = "";
    fields[dec.info] = "";
    fields[dec.claimCents] = 0;
    fields[dec.balanceCents] = 0;
    fields[dec.amountCents] = 0;
  }
  return fields;
}

export interface ComputeTtbFiguresArgs {
  period: TaxPeriod;
  barrelsByChannel: Record<string, number>;
  barrelsYearToDate: number;
  unknownChannels: string[];
  rateMicros: number;
}

/**
 * Pure worksheet builder. Maps channel barrels onto the form via the shared
 * `deriveTtbFigures`, then raises the three guards that keep this module's
 * simplifications honest:
 *
 *  - TIER CEILING. Everything is reported on Line 8 at the reduced rate. That
 *    is only correct below 60,000 bbl of calendar-year removals. Warn well
 *    before the ceiling (at 90%) rather than silently under-reporting the
 *    moment it is crossed.
 *  - UNKNOWN CHANNEL. A shipment channel this party doesn't know about is
 *    still a federal removal, and `deriveTtbFigures` would not count it. Name
 *    it rather than quietly dropping barrels off the return.
 *  - CARRIED INVENTORY. The reporting method assumes Line 44 lands on zero. If
 *    an entry ever makes it positive, that balance is a real opening figure for
 *    next quarter and someone has to know.
 */
export function computeTtbFigures(args: ComputeTtbFiguresArgs): WorksheetData {
  const { period, barrelsByChannel, barrelsYearToDate, unknownChannels, rateMicros } = args;
  const warnings: string[] = [];

  const fields: WorksheetFields = {
    // Header — Lines 1, 3a-3c.
    serial_number: ttbSerialNumber(period.start),
    reporting_year: Number(period.start.slice(0, 4)),
    period_label: ttbPeriodLabel(period.start),
    period_start: period.start,
    period_end: period.end,
    submission_version: "Original",
    flag_final_return: 0,
    final_return_date: "",

    // Payment — Lines 2a-2c.
    prev_serial_number: "",
    cents_previously_paid: 0,
    payment_form: "",
    cents_amount_paid: 0,

    // Removals from the shipment feed.
    bbl_distribution: barrelsByChannel.distribution ?? 0,
    bbl_contract: barrelsByChannel.contract_brewing ?? 0,
    bbl_taproom: barrelsByChannel.taproom ?? 0,
    bbl_wholesale: barrelsByChannel.wholesale ?? 0,
    ttb_reduced_rate_micros: rateMicros,

    // Lines 34-36 — removals without payment of tax (no channel carries these).
    bbl_exports_without_tax: 0,
    bbl_transfers_in_bond: 0,
    bbl_other_removals_without_tax: 0,

    // Lines 30-32, 38-40 — inventory movements outside the shipment feed.
    bbl_received_in_bond: 0,
    bbl_returned_after_removal: 0,
    bbl_inventory_overage: 0,
    bbl_consumed_or_destroyed: 0,
    bbl_losses: 0,
    bbl_inventory_shortage: 0,
    flag_shortages_taxpaid: 0,

    // Lines 21-22 — interest and penalties.
    cents_interest: 0,
    cents_penalties: 0,

    // Line 45 — controlled group membership.
    flag_controlled_group: 0,
    flag_controlled_group_domestic: 0,
    flag_controlled_group_foreign: 0,

    // Line 50.
    signer_date: "",

    ...blankScheduleA(),
  };

  const derived = deriveTtbFigures(fields);

  const ceiling = TTB_REDUCED_TIER_LIMIT_BBL * 0.9;
  if (barrelsYearToDate > ceiling) {
    warnings.push(
      `Calendar-year removals through this period are ${barrelsYearToDate.toFixed(2)} bbl, within 10% of the ${TTB_REDUCED_TIER_LIMIT_BBL.toLocaleString()} bbl reduced-rate ceiling. This worksheet reports every barrel on Line 8 at the reduced rate — barrels above the ceiling belong on Line 9 at $16.00, which it does not yet split out.`,
    );
  }

  if (unknownChannels.length > 0) {
    warnings.push(
      `Shipment channel${unknownChannels.length === 1 ? "" : "s"} not recognized by this return: ${unknownChannels.join(", ")}. Those barrels are federal removals but are NOT counted on Line 8 — add the channel to TTB_TAXABLE_CHANNELS before filing.`,
    );
  }

  if (num(derived.bbl_ending) > 0) {
    warnings.push(
      `Line 44 (beer on hand at end of period) is ${num(derived.bbl_ending).toFixed(2)} bbl, not zero. This brewery's reporting method assumes nothing carries over, so that balance must be entered as next quarter's Line 28 opening inventory.`,
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
 * Compute the TTB worksheet for a filing period. Reads removal barrels from
 * `export_transactions` and the live federal rate from the canonical
 * `tax_rates` row (key `federal_beer_excise`), falling back to the statutory
 * $3.50/bbl if that row is missing.
 *
 * `sb` defaults to the service-role admin client; it's injectable so this is
 * testable without a live DB.
 */
export async function computeTtbWorksheet(ctx: ComputeContext, sb?: SupabaseClient): Promise<WorksheetData> {
  const client = sb ?? (await import("@/lib/supabase/admin")).createSupabaseAdminClient();

  const [data, fetchedMicros] = await Promise.all([
    fetchRemovalData(client, ctx.period),
    fetchTtbRateMicros(client),
  ]);

  const warnings: string[] = [];
  const micros = fetchedMicros ?? TTB_REDUCED_RATE_MICROS_FALLBACK;
  if (fetchedMicros == null) {
    warnings.push(
      `No active federal beer-excise barrel rate configured — using the statutory fallback ($${TTB_REDUCED_RATE_USD_FALLBACK.toFixed(2)}/bbl). Set the rate in Finance > Settings > Excise Tax.`,
    );
  }

  const computed = computeTtbFigures({
    period: ctx.period,
    barrelsByChannel: data.barrelsByChannel,
    barrelsYearToDate: data.barrelsYearToDate,
    unknownChannels: data.unknownChannels,
    rateMicros: micros,
  });

  const allWarnings = [...warnings, ...(computed.warnings ?? [])];
  const result: WorksheetData = { ...computed };
  if (allWarnings.length > 0) result.warnings = allWarnings;
  else delete result.warnings;
  return result;
}
