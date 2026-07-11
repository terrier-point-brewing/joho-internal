import { describe, it, expect } from "vitest";
import {
  assembleInvoiceSalesReport,
  type InvoiceRow,
  type LineItemRow,
  type ExportTxnRow,
} from "./invoiceSalesReport";

// Fixed "now" well past the report year so all 12 months are present.
const NOW = new Date("2026-12-31T12:00:00Z");
const YEAR = 2026;

const li = (over: Partial<LineItemRow>): LineItemRow => ({
  category: null,
  total_cents: null,
  chart_of_accounts_id: "coa-1",
  variation_name: null,
  quantity: null,
  raw_data: null,
  line_item_name: null,
  gross_sales_cents: null,
  discount_cents: null,
  ...over,
});

const txn = (over: Partial<ExportTxnRow>): ExportTxnRow => ({
  channel: "distribution",
  volume_bbl: null,
  quantity: null,
  variant_label: null,
  export_transaction_taxes: null,
  ...over,
});

const invoice = (over: Partial<InvoiceRow>): InvoiceRow => ({
  id: "inv-1",
  invoice_date: "2026-03-10",
  status: "paid",
  total_cents: null,
  invoice_line_items: null,
  export_transactions: null,
  ...over,
});

describe("assembleInvoiceSalesReport — mixed-unit money seam", () => {
  it("converts line-item cents to dollars while summing excise dollars as-is", () => {
    const report = assembleInvoiceSalesReport(
      [
        invoice({
          total_cents: 60_000,
          invoice_line_items: [
            li({
              category: "distribution_keg",
              variation_name: "1/2 BBL Keg",
              total_cents: 60_000,
              raw_data: { name: "Half keg", gross: 60_000, discount: 500 },
            }),
          ],
          export_transactions: [
            txn({
              channel: "distribution",
              volume_bbl: 0.5,
              quantity: 2,
              variant_label: "1/2 BBL",
              export_transaction_taxes: [
                { tax_name: "NC Excise Tax", amount_usd: 3.45 },
                { tax_name: "Federal Excise Tax", amount_usd: 7.1 },
              ],
            }),
          ],
        }),
      ],
      YEAR,
      NOW
    );

    const row = report.distribution["2026-03"];

    // Revenue: 60_000 cents ÷ 100 = $600.00. A dropped ÷100 would read 60000.
    expect(row.rev_half_keg).toBe(600);
    expect(row.gross_revenue).toBe(600);
    // Discount: 500 cents ÷ 100 = $5.00.
    expect(row.discounts).toBe(5);
    expect(row.net_sales).toBe(595); // 600 - 5

    // Excise: amount_usd is already DOLLARS — summed directly, NOT ×100 / ÷100.
    // A stray ×100 would give 345; a stray ÷100 would give 0.0345.
    expect(row.excise_tax_nc).toBe(3.45);
    expect(row.excise_tax_federal).toBe(7.1);

    // Volume attribution.
    expect(row.total_bbl).toBe(0.5);
    expect(row.vol_half_keg).toBe(2);

    // Liable shipment with recorded excise → no coverage gap.
    expect(report.exciseCoverage.missingDetailTxns).toBe(0);
  });

  it("keeps revenue-cents and excise-dollars on independent scales (guard)", () => {
    // Same numeric magnitude in both units proves they are scaled differently:
    // 10_000 cents of revenue must become $100, while 100 dollars of excise stays $100.
    const report = assembleInvoiceSalesReport(
      [
        invoice({
          invoice_line_items: [
            li({ category: "distribution_can", total_cents: 10_000, raw_data: { gross: 10_000 } }),
          ],
          export_transactions: [
            txn({
              channel: "distribution",
              volume_bbl: 1,
              quantity: 24,
              variant_label: "cans",
              export_transaction_taxes: [{ tax_name: "Federal Excise", amount_usd: 100 }],
            }),
          ],
        }),
      ],
      YEAR,
      NOW
    );
    const row = report.distribution["2026-03"];
    expect(row.rev_cans).toBe(100);          // 10_000 cents → $100
    expect(row.excise_tax_federal).toBe(100); // $100 dollars → $100
  });

  it("routes contract-brewing revenue (cents → dollars) to the right row", () => {
    const report = assembleInvoiceSalesReport(
      [
        invoice({
          invoice_line_items: [
            li({ category: "materials_packaging", total_cents: 25_000, raw_data: { gross: 25_000 } }),
            li({ category: "packaging_fees", total_cents: 5_000, raw_data: { gross: 5_000 } }),
          ],
          export_transactions: [txn({ channel: "contract_brewing", volume_bbl: 2, quantity: 4 })],
        }),
      ],
      YEAR,
      NOW
    );
    const row = report.contractBrewing["2026-03"];
    expect(row.materials_packaging).toBe(250);
    expect(row.packaging_fees).toBe(50);
    expect(row.gross_revenue).toBe(300);
  });

  it("flags a TPB-liable shipment with volume but no recorded excise", () => {
    const report = assembleInvoiceSalesReport(
      [
        invoice({
          invoice_line_items: [
            li({ category: "distribution_can", total_cents: 1_000, raw_data: { gross: 1_000 } }),
          ],
          export_transactions: [txn({ channel: "distribution", volume_bbl: 1.5, quantity: 12, variant_label: "cans" })],
        }),
      ],
      YEAR,
      NOW
    );
    expect(report.exciseCoverage.missingDetailTxns).toBe(1);
    expect(report.exciseCoverage.byChannel.distribution).toBe(1);
  });

  it("does not flag wholesale (no TPB excise liability) for missing excise", () => {
    const report = assembleInvoiceSalesReport(
      [
        invoice({
          invoice_line_items: [
            li({ category: "distribution_keg", variation_name: "1/6 BBL", total_cents: 8_000, raw_data: { gross: 8_000 } }),
          ],
          export_transactions: [txn({ channel: "wholesale", volume_bbl: 0.5, quantity: 3, variant_label: "1/6 BBL" })],
        }),
      ],
      YEAR,
      NOW
    );
    expect(report.exciseCoverage.missingDetailTxns).toBe(0);
    expect(report.wholesale["2026-03"].rev_sixth_keg).toBe(80); // 8_000 cents → $80
  });

  it("sends unassigned-channel revenue to unrecognized (in dollars)", () => {
    const report = assembleInvoiceSalesReport(
      [
        invoice({
          invoice_line_items: [
            li({ category: "distribution_can", total_cents: 4_200, raw_data: { gross: 4_200 } }),
          ],
          export_transactions: [], // no channel link
        }),
      ],
      YEAR,
      NOW
    );
    expect(report.unrecognized.count).toBe(1);
    expect(report.unrecognized.totalDollars).toBe(42); // 4_200 cents → $42
    expect(report.unrecognized.byChannel.unassigned).toBe(42);
  });

  it("prefers dedicated gross_sales_cents/discount_cents columns over raw_data (post-migration rows)", () => {
    // After the Square sync refactor, new rows carry dedicated columns and
    // raw_data is null. The reader must not silently read gross=0/discount=0.
    const report = assembleInvoiceSalesReport(
      [
        invoice({
          invoice_line_items: [
            li({
              category: "distribution_keg",
              variation_name: "1/2 BBL Keg",
              total_cents: 60_000,
              raw_data: null,
              line_item_name: "Half keg",
              gross_sales_cents: 60_000,
              discount_cents: 500,
            }),
          ],
          export_transactions: [
            txn({ channel: "distribution", volume_bbl: 0.5, quantity: 2, variant_label: "1/2 BBL" }),
          ],
        }),
      ],
      YEAR,
      NOW
    );

    const row = report.distribution["2026-03"];
    expect(row.rev_half_keg).toBe(600); // 60_000 cents ÷ 100
    expect(row.gross_revenue).toBe(600);
    expect(row.discounts).toBe(5); // 500 cents ÷ 100
    expect(row.net_sales).toBe(595);
  });

  it("handles empty input — zeroed months, no excise, no unrecognized", () => {
    const report = assembleInvoiceSalesReport([], YEAR, NOW);
    expect(report.months).toHaveLength(12);
    expect(report.distribution["2026-03"].gross_revenue).toBe(0);
    expect(report.unrecognized.totalDollars).toBe(0);
    expect(report.exciseCoverage.missingDetailTxns).toBe(0);
  });
});
