// Server half of the forecast: reads the production and invoice history the
// statement rows cannot tell the browser about, and reduces it to the small
// ForecastDrivers payload. Read-only — it writes nothing and is imported by
// nothing in lib/finance/financials.

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { localDateString } from "@/lib/utils/datetime";
import { EXCISE_EXPENSE_ACCOUNT_NUMBER } from "@/lib/finance/exciseExpense";
import { addMonths, buildDrawdownHistory, daysBetween, type HistoryBatch, type HistoryShipment } from "./drawdown";
import { DRAWDOWN_CHANNELS, type DrawdownChannel, type ForecastDrivers, type ForecastPartner, type ForecastSpreadBill } from "./types";
import { fetchCoa } from "@/lib/finance/financials/fetchSources";
import { coaSection, type CoaRecord } from "@/lib/finance/financials/aggregateRows";
import { fetchSpreadExpenses, type SpreadExpense } from "@/lib/finance/servicePeriod.server";
import { fullMonthRateCents, isSpreadableSection, recognitionByMonth, servicePeriodMonths } from "@/lib/finance/servicePeriod";

/** Batches older than this have nothing left to ship that the curve would count on. */
const BATCH_LOOKBACK_DAYS = 270;

interface BatchRow {
  id: string;
  planned_brew_date: string | null;
  volume_bbl: number | string | null;
  source: string | null;
  converted_from_batch_id: string | null;
}

interface ExportRow {
  batch_id: string | null;
  volume_bbl: number | string | null;
  channel: string | null;
  created_at: string;
  is_phantom: boolean | null;
}

interface InvoiceRow {
  partner_id: string | null;
  billed_channel: string | null;
  subtotal_cents: number | string | null;
  invoice_date: string | null;
}

function isDrawdownChannel(value: string | null): value is DrawdownChannel {
  return value !== null && (DRAWDOWN_CHANNELS as string[]).includes(value);
}

/**
 * Spread bills as the forecast reads them: one entry per income-statement line.
 * A raw expense amount already carries the statements' sign for a P&L account
 * (an outflow is negative, a cost is negative), so nothing is flipped here.
 */
export function toForecastSpreadBills(bills: SpreadExpense[], coa: CoaRecord[]): ForecastSpreadBill[] {
  const coaMap = new Map(coa.map((c) => [c.id, c]));
  const out: ForecastSpreadBill[] = [];
  for (const bill of bills) {
    for (const line of bill.lines) {
      if (!line.chartOfAccountsId || line.amountCents === 0) continue;
      if (!isSpreadableSection(coaSection(coaMap.get(line.chartOfAccountsId)))) continue;
      const recognition = recognitionByMonth(line.amountCents, bill.period, bill.accountingDate.slice(0, 7));
      out.push({
        coaId: line.chartOfAccountsId,
        amountCents: line.amountCents,
        monthlyCents: fullMonthRateCents(line.amountCents, bill.period),
        periodMonths: servicePeriodMonths(bill.period),
        periodStartMonth: bill.period.start.slice(0, 7),
        periodEndMonth: bill.period.end.slice(0, 7),
        recognitionCentsByMonth: Object.fromEntries(recognition.map((r) => [r.monthKey, r.amountCents])),
        paidMonth: bill.paidDate ? bill.paidDate.slice(0, 7) : null,
      });
    }
  }
  return out;
}

/**
 * Pure reduction of the raw rows, split out so it can be tested without a
 * database.
 *
 * A conversion child batch is beer carved out of its parent, not new beer: its
 * shipments are credited to the batch that was actually brewed, and it adds
 * nothing to the brewing pace.
 */
export function reduceDrivers(input: {
  asOf: string;
  batches: BatchRow[];
  exports: ExportRow[];
  payrollCoaIds: string[];
  invoices: InvoiceRow[];
  partnerNames: Map<string, string>;
  cashOnHandCents: number | null;
  spreadBills?: ForecastSpreadBill[];
}): ForecastDrivers {
  const { asOf } = input;
  const openMonth = asOf.slice(0, 7);

  const byId = new Map(input.batches.map((b) => [b.id, b]));
  const rootOf = (id: string): string => {
    let current = id;
    for (let hops = 0; hops < 10; hops++) {
      const parent = byId.get(current)?.converted_from_batch_id;
      if (!parent || !byId.has(parent)) break;
      current = parent;
    }
    return current;
  };

  const brewed: HistoryBatch[] = input.batches
    .filter((b) => b.source !== "purchased" && !b.converted_from_batch_id && b.planned_brew_date && Number(b.volume_bbl) > 0)
    .filter((b) => b.planned_brew_date! <= asOf)
    .map((b) => ({ id: b.id, brewDate: b.planned_brew_date!, bbl: Number(b.volume_bbl) }));
  const brewedIds = new Set(brewed.map((b) => b.id));

  const shipments: HistoryShipment[] = [];
  const shippedBblByMonth: ForecastDrivers["shippedBblByMonth"] = { contract_brewing: {}, distribution: {}, taproom: {} };
  const shippedByBatch = new Map<string, number>();
  for (const e of input.exports) {
    const bbl = Number(e.volume_bbl);
    if (e.is_phantom || !isDrawdownChannel(e.channel) || !(bbl > 0)) continue;
    const date = localDateString(e.created_at);
    const month = date.slice(0, 7);
    shippedBblByMonth[e.channel][month] = (shippedBblByMonth[e.channel][month] ?? 0) + bbl;
    if (!e.batch_id) continue;
    const root = rootOf(e.batch_id);
    if (!brewedIds.has(root)) continue;
    shipments.push({ batchId: root, channel: e.channel, date, bbl });
    shippedByBatch.set(root, (shippedByBatch.get(root) ?? 0) + bbl);
  }

  const history = buildDrawdownHistory(asOf, brewed, shipments);

  const paceMonths = [1, 2, 3].map((n) => addMonths(openMonth, -n));
  const brewPaceBblPerMonth =
    brewed.filter((b) => paceMonths.includes(b.brewDate.slice(0, 7))).reduce((sum, b) => sum + b.bbl, 0) / paceMonths.length;

  // Partner share of recent invoiced revenue, per channel.
  const channelTotal: Record<string, number> = {};
  const partnerTotal = new Map<string, Record<string, number>>();
  for (const inv of input.invoices) {
    if (!inv.invoice_date || !paceMonths.includes(inv.invoice_date.slice(0, 7))) continue;
    const channel = inv.billed_channel ?? "contract_brewing";
    if (!isDrawdownChannel(channel)) continue;
    const cents = Number(inv.subtotal_cents) || 0;
    channelTotal[channel] = (channelTotal[channel] ?? 0) + cents;
    if (!inv.partner_id) continue;
    const bucket = partnerTotal.get(inv.partner_id) ?? {};
    bucket[channel] = (bucket[channel] ?? 0) + cents;
    partnerTotal.set(inv.partner_id, bucket);
  }
  const partners: ForecastPartner[] = [...partnerTotal.entries()]
    .map(([id, totals]) => ({
      id,
      name: input.partnerNames.get(id) ?? "Unnamed partner",
      shareByChannel: Object.fromEntries(
        Object.entries(totals).map(([c, cents]) => [c, channelTotal[c] > 0 ? Math.max(0, Math.min(1, cents / channelTotal[c])) : 0]),
      ) as ForecastPartner["shareByChannel"],
    }))
    .sort((x, y) => x.name.localeCompare(y.name));

  return {
    asOf,
    openMonth,
    ...history,
    batches: brewed
      .filter((b) => daysBetween(b.brewDate, asOf) <= BATCH_LOOKBACK_DAYS)
      .map((b) => ({ brewDate: b.brewDate, bbl: b.bbl, shippedBbl: shippedByBatch.get(b.id) ?? 0 })),
    brewPaceBblPerMonth,
    shippedBblByMonth,
    payrollCoaIds: input.payrollCoaIds,
    exciseAccountNumber: EXCISE_EXPENSE_ACCOUNT_NUMBER,
    partners,
    cashOnHandCents: input.cashOnHandCents,
    spreadBills: input.spreadBills ?? [],
  };
}

export async function fetchForecastDrivers(
  supabase: SupabaseClient,
  asOf: string,
  cashOnHandCents: number | null,
): Promise<ForecastDrivers> {
  const [batches, exports, payrollTotals, invoices, partners, spreadExpenses, coa] = await Promise.all([
    fetchAllRows<BatchRow>(() =>
      supabase.from("brew_batches").select("id, planned_brew_date, volume_bbl, source, converted_from_batch_id").order("id"),
    ),
    fetchAllRows<ExportRow>(() =>
      supabase.from("export_transactions").select("batch_id, volume_bbl, channel, created_at, is_phantom").order("id"),
    ),
    fetchAllRows<{ chart_of_accounts_id: string | null }>(() =>
      supabase.from("payroll_gl_report_totals").select("chart_of_accounts_id").order("id"),
    ),
    fetchAllRows<InvoiceRow>(() =>
      supabase
        .from("invoices")
        .select("partner_id, billed_channel, subtotal_cents, invoice_date")
        .is("voided_at", null)
        .gte("invoice_date", `${addMonths(asOf.slice(0, 7), -3)}-01`)
        .order("id"),
    ),
    fetchAllRows<{ id: string; company_name: string | null }>(() =>
      supabase.from("contract_brewing_partners").select("id, company_name").order("id"),
    ),
    fetchSpreadExpenses(supabase, asOf),
    fetchCoa(supabase),
  ]);

  return reduceDrivers({
    asOf,
    batches,
    exports,
    payrollCoaIds: [...new Set(payrollTotals.map((t) => t.chart_of_accounts_id).filter((id): id is string => !!id))],
    invoices,
    partnerNames: new Map(partners.map((p) => [p.id, p.company_name ?? "Unnamed partner"])),
    cashOnHandCents,
    spreadBills: toForecastSpreadBills(spreadExpenses, coa),
  });
}
