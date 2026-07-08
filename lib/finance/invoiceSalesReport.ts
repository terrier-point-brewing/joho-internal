// Ledger-backed invoice sales report.
//
// Replaces the old live-Square name-parsing approach in
// /api/finance/sales/invoices. Instead of re-fetching Square orders and
// re-classifying line items by hard-coded name matching, this reads the
// established ledger linkages:
//
//   • Revenue + account ── invoice_line_items.category + chart_of_accounts_id,
//     classified once at send/sync time by lib/finance/syncSquareInvoices.ts.
//   • Channel ──────────── export_transactions.channel (distribution |
//     contract_brewing | wholesale), linked via export_transactions.invoice_id.
//   • Volume ──────────── export_transactions.volume_bbl / quantity.
//   • Excise ──────────── export_transaction_taxes — the EXCISE ACTUALLY CHARGED
//     per shipment. Excise is NOT recomputed from volume × rate: liability is
//     channel-dependent (TPB owes excise on contract_brewing + distribution but
//     NOT on wholesale), so a flat volume calculation would fabricate a
//     wholesale liability that doesn't exist. We only report what was charged.
//
// An invoice flows in its entirety to the channel of its linked export
// transactions (the confirmed intent of the three-channel rework). Any
// line-item revenue that can't be placed into a displayed row — uncategorized
// ("other") items, invoices with no channel link, or invoices with no
// line-item detail — is summed into `unrecognized` so the UI can surface it in
// a banner instead of silently dropping it. Likewise, TPB-liable shipments that
// are missing recorded excise detail are surfaced via `exciseCoverage` so excise
// is never silently under-reported.

import type { SupabaseClient } from "@supabase/supabase-js";

export type ReportChannel = "distribution" | "contract_brewing" | "wholesale";

const REPORT_CHANNELS: ReportChannel[] = ["distribution", "contract_brewing", "wholesale"];

// Channels where TPB is responsible for paying excise. Wholesale is excluded —
// excise on wholesale shipments is the buyer's liability, not TPB's.
const EXCISE_LIABLE_CHANNELS = new Set<ReportChannel>(["distribution", "contract_brewing"]);

export interface LineItemRow {
  category: string | null;
  total_cents: number | null;
  chart_of_accounts_id: string | null;
  variation_name: string | null;
  quantity: number | null;
  raw_data: Record<string, unknown> | null;
}

export interface ExciseTaxRow {
  tax_name: string;
  amount_usd: number | null;
}

export interface ExportTxnRow {
  channel: string;
  volume_bbl: number | null;
  quantity: number | null;
  variant_label: string | null;
  export_transaction_taxes: ExciseTaxRow[] | null;
}

export interface InvoiceRow {
  id: string;
  invoice_date: string | null;
  status: string;
  total_cents: number | null;
  invoice_line_items: LineItemRow[] | null;
  export_transactions: ExportTxnRow[] | null;
}

export interface UnrecognizedSample {
  description: string;
  category: string | null;
  channel: string;
  invoiceDate: string | null;
  amountDollars: number;
  reason: "uncategorized" | "no_channel" | "ambiguous_channel" | "no_line_items" | "off_channel";
}

export interface UnrecognizedSummary {
  totalDollars: number;       // revenue that landed in no displayed row
  count: number;              // number of offending line items / invoices
  unmappedAccountCount: number; // placed items still missing a GL account
  byChannel: Record<string, number>; // dollars, keyed by channel | "unassigned"
  samples: UnrecognizedSample[];
}

// Surfaces TPB-liable shipments whose excise wasn't recorded, so reported
// excise (sum of what was actually charged) is never silently understated.
export interface ExciseCoverage {
  missingDetailTxns: number;            // count of liable txns with volume but no recorded excise
  byChannel: Record<string, number>;    // channel → missing count
}

export interface InvoiceSalesReport {
  year: number;
  months: string[];
  distribution: Record<string, Record<string, number>>;
  contractBrewing: Record<string, Record<string, number>>;
  wholesale: Record<string, Record<string, number>>;
  unrecognized: UnrecognizedSummary;
  exciseCoverage: ExciseCoverage;
}

// ---------------------------------------------------------------------------
// Small classifiers (string-shape only — not business classification)
// ---------------------------------------------------------------------------

function kegSize(label: string | null): "half" | "quarter" | "sixth" | null {
  if (!label) return null;
  const n = label.toLowerCase();
  if (n.includes("1/2")) return "half";
  if (n.includes("1/4")) return "quarter";
  if (n.includes("1/6")) return "sixth";
  return null;
}

function exciseBucket(taxName: string): "nc" | "federal" | null {
  const n = taxName.toLowerCase();
  if (n.includes("federal")) return "federal";
  if (n.includes("nc"))      return "nc";
  return null;
}

function emptyMonth(): Record<string, number> {
  return {
    // Volume
    vol_half_keg: 0, vol_quarter_keg: 0, vol_sixth_keg: 0, vol_cans: 0, total_bbl: 0,
    // Distribution / wholesale revenue (by container)
    rev_half_keg: 0, rev_quarter_keg: 0, rev_sixth_keg: 0, rev_cans: 0,
    // Contract-brewing revenue (by category)
    materials_packaging: 0, packaging_fees: 0, other_services: 0, pass_through_taxes: 0,
    // Shared totals
    gross_revenue: 0, discounts: 0, remits: 0, deduct_pass_through: 0,
    total_deductions: 0, net_sales: 0,
    excise_tax_nc: 0, excise_tax_federal: 0,
  };
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export async function buildInvoiceSalesReport(
  supabase: SupabaseClient,
  year: number
): Promise<InvoiceSalesReport> {
  // One query gets revenue (line items) + channel/volume/excise (export txns)
  // for every non-draft export invoice in the year. Drafts are excluded: their
  // line items carry placeholder categories until send/sync. Excise comes from
  // export_transaction_taxes — what was actually charged per shipment.
  const { data, error } = await supabase
    .from("invoices")
    .select(`
      id, invoice_date, status, total_cents,
      invoice_line_items!invoice_line_items_invoice_id_fkey ( category, total_cents, chart_of_accounts_id, variation_name, quantity, raw_data ),
      export_transactions (
        channel, volume_bbl, quantity, variant_label,
        export_transaction_taxes ( tax_name, amount_usd )
      )
    `)
    .eq("invoice_type", "export_invoice")
    .neq("status", "draft")
    .gte("invoice_date", `${year}-01-01`)
    .lte("invoice_date", `${year}-12-31`);

  if (error) throw error;

  return assembleInvoiceSalesReport((data ?? []) as unknown as InvoiceRow[], year);
}

/**
 * Pure assembly of the invoice sales report from already-fetched invoice rows.
 *
 * This is the mixed-unit money seam: line-item revenue arrives as INTEGER CENTS
 * (`total_cents`, `raw_data.gross/discount`) and is divided by 100 into dollars,
 * while excise arrives as DECIMAL DOLLARS (`amount_usd`) and is summed as-is.
 * Both must land in the same dollar-denominated statement row, so the ÷100 must
 * be applied to revenue and NOT to excise.
 *
 * `now` is injectable so the "months so far" logic is testable deterministically.
 */
export function assembleInvoiceSalesReport(
  invoices: readonly InvoiceRow[],
  year: number,
  now: Date = new Date()
): InvoiceSalesReport {
  const months: string[] = [];
  for (let m = 1; m <= 12; m++) {
    if (year < now.getFullYear() || m <= now.getMonth() + 1) {
      months.push(`${year}-${String(m).padStart(2, "0")}`);
    }
  }

  const exciseCoverage: ExciseCoverage = {
    missingDetailTxns: 0,
    byChannel: { distribution: 0, contract_brewing: 0 },
  };

  const monthMaps: Record<ReportChannel, Record<string, Record<string, number>>> = {
    distribution:     {},
    contract_brewing: {},
    wholesale:        {},
  };
  for (const ch of REPORT_CHANNELS) {
    for (const ym of months) monthMaps[ch][ym] = emptyMonth();
  }

  const unrecognized: UnrecognizedSummary = {
    totalDollars: 0,
    count: 0,
    unmappedAccountCount: 0,
    byChannel: { distribution: 0, contract_brewing: 0, wholesale: 0, unassigned: 0 },
    samples: [],
  };

  function flagUnrecognized(s: UnrecognizedSample) {
    unrecognized.totalDollars += s.amountDollars;
    unrecognized.count += 1;
    const key = (REPORT_CHANNELS as string[]).includes(s.channel) ? s.channel : "unassigned";
    unrecognized.byChannel[key] = (unrecognized.byChannel[key] ?? 0) + s.amountDollars;
    if (unrecognized.samples.length < 25) unrecognized.samples.push(s);
  }

  for (const inv of invoices) {
    const ym = (inv.invoice_date ?? "").slice(0, 7);
    if (!months.includes(ym)) continue;

    const txns = inv.export_transactions ?? [];
    const lineItems = inv.invoice_line_items ?? [];

    // ── Volume + excise: attribute each export transaction to its own channel ──
    for (const txn of txns) {
      if (!(REPORT_CHANNELS as string[]).includes(txn.channel)) continue; // e.g. taproom
      const channel = txn.channel as ReportChannel;
      const row = monthMaps[channel][ym];
      row.total_bbl += Number(txn.volume_bbl ?? 0);
      const sz = kegSize(txn.variant_label);
      if (sz) row[`vol_${sz}_keg`] += Number(txn.quantity ?? 0);
      else    row.vol_cans         += Number(txn.quantity ?? 0);

      // Excise = what was actually charged on this shipment. Wholesale carries
      // no TPB excise liability, so it legitimately has no tax rows.
      const taxes = txn.export_transaction_taxes ?? [];
      for (const t of taxes) {
        const b = exciseBucket(t.tax_name);
        if (b === "nc")           row.excise_tax_nc      += Number(t.amount_usd ?? 0);
        else if (b === "federal") row.excise_tax_federal += Number(t.amount_usd ?? 0);
      }

      // Coverage: a TPB-liable shipment with volume but no recorded excise means
      // reported excise is understated — flag it rather than silently miss it.
      if (EXCISE_LIABLE_CHANNELS.has(channel) && Number(txn.volume_bbl ?? 0) > 0 && taxes.length === 0) {
        exciseCoverage.missingDetailTxns += 1;
        exciseCoverage.byChannel[channel] = (exciseCoverage.byChannel[channel] ?? 0) + 1;
      }
    }

    // ── Revenue: the whole invoice flows to its single channel ────────────────
    const channels = new Set(
      txns.map((t) => t.channel).filter((c) => (REPORT_CHANNELS as string[]).includes(c))
    );
    const revChannel: ReportChannel | null = channels.size === 1 ? ([...channels][0] as ReportChannel) : null;

    // Invoice has a channel but no line-item detail (e.g. mark_paid backfill):
    // its total can't be categorized — surface as unrecognized.
    if (lineItems.length === 0 && revChannel) {
      flagUnrecognized({
        description: "(invoice total — no line items)",
        category: null,
        channel: revChannel,
        invoiceDate: inv.invoice_date,
        amountDollars: Number(inv.total_cents ?? 0) / 100,
        reason: "no_line_items",
      });
      continue;
    }

    for (const li of lineItems) {
      const raw = li.raw_data ?? {};
      const grossCents = Number((raw as Record<string, unknown>).gross ?? li.total_cents ?? 0);
      const discCents  = Number((raw as Record<string, unknown>).discount ?? 0);
      const gross = grossCents / 100;
      const disc  = discCents / 100;
      const desc  = String((raw as Record<string, unknown>).name ?? li.category ?? "(unnamed)");

      if (!revChannel) {
        flagUnrecognized({
          description: desc,
          category: li.category,
          channel: channels.size === 0 ? "unassigned" : "ambiguous",
          invoiceDate: inv.invoice_date,
          amountDollars: gross,
          reason: channels.size === 0 ? "no_channel" : "ambiguous_channel",
        });
        continue;
      }

      const row = monthMaps[revChannel][ym];
      const placed = addRevenue(row, revChannel, li, gross, disc);

      if (!placed) {
        flagUnrecognized({
          description: desc,
          category: li.category,
          channel: revChannel,
          invoiceDate: inv.invoice_date,
          amountDollars: gross,
          reason: li.category === "other" || li.category == null ? "uncategorized" : "off_channel",
        });
      } else if (!li.chart_of_accounts_id) {
        // Placed in a row but no GL account mapped — track separately (not
        // subtracted; informational for the account-mapping settings page).
        unrecognized.unmappedAccountCount += 1;
      }
    }
  }

  // ── Finalize per-channel monthly totals ────────────────────────────────────
  for (const ch of REPORT_CHANNELS) {
    for (const ym of months) {
      const row = monthMaps[ch][ym];
      row.total_deductions = row.discounts + row.remits + row.deduct_pass_through;
      row.net_sales = row.gross_revenue - row.total_deductions;
      // Round accumulated actual-charged excise to cents.
      row.excise_tax_nc      = Math.round(row.excise_tax_nc      * 100) / 100;
      row.excise_tax_federal = Math.round(row.excise_tax_federal * 100) / 100;
    }
  }

  unrecognized.totalDollars = Math.round(unrecognized.totalDollars * 100) / 100;

  return {
    year,
    months,
    distribution:    monthMaps.distribution,
    contractBrewing: monthMaps.contract_brewing,
    wholesale:       monthMaps.wholesale,
    unrecognized,
    exciseCoverage,
  };
}

// Place a line item's revenue into the appropriate displayed row for its
// channel. Returns false if it doesn't map to any displayed row (caller then
// flags it as unrecognized). gross/disc are in dollars.
function addRevenue(
  row: Record<string, number>,
  channel: ReportChannel,
  li: LineItemRow,
  gross: number,
  disc: number
): boolean {
  const cat = li.category;

  if (channel === "distribution" || channel === "wholesale") {
    if (cat === "distribution_keg") {
      const sz = kegSize(li.variation_name);
      if (!sz) return false;
      row[`rev_${sz}_keg`] += gross;
      row.gross_revenue += gross;
      row.discounts += disc;
      return true;
    }
    if (cat === "distribution_can") {
      row.rev_cans += gross;
      row.gross_revenue += gross;
      row.discounts += disc;
      return true;
    }
    return false;
  }

  // contract_brewing
  switch (cat) {
    case "materials_packaging":
    case "ingredient_deposit": // folded into Materials & Packaging for this view
      row.materials_packaging += gross;
      row.gross_revenue += gross;
      row.discounts += disc;
      return true;
    case "packaging_fees":
      row.packaging_fees += gross;
      row.gross_revenue += gross;
      row.discounts += disc;
      return true;
    case "other_services":
      row.other_services += gross;
      row.gross_revenue += gross;
      row.discounts += disc;
      return true;
    case "pass_through_taxes":
      row.pass_through_taxes += gross;
      row.gross_revenue += gross;
      row.deduct_pass_through += gross; // remitted → nets to zero
      row.discounts += disc;
      return true;
    default:
      return false;
  }
}
