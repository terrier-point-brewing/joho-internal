import { describe, it, expect } from "vitest";
import { aggregateRows, type AggregateRowsInput, type CoaRecord } from "./aggregateRows";
import { CATEGORY_IDS } from "@/lib/constants/categories";

const KEG_CAT = [...CATEGORY_IDS.KEGS][0];

const COA: CoaRecord[] = [
  { id: "coa-beer", parentId: null, accountName: "Beer Sales", accountType: "Income", statementSection: null },
  { id: "coa-bs-deposit", parentId: null, accountName: "Customer Deposits", accountType: "Other Current Liabilities", statementSection: null },
  { id: "coa-pl-deposit", parentId: null, accountName: "Distribution Revenue", accountType: "Income", statementSection: null },
  { id: "coa-expense", parentId: null, accountName: "Supplies", accountType: "Expenses", statementSection: null },
];

function emptyInput(overrides: Partial<AggregateRowsInput> = {}): AggregateRowsInput {
  return {
    pos: [],
    invoiceLines: [],
    expenses: [],
    refunds: [],
    bank: [],
    coa: COA,
    months: ["2026-01", "2026-02"],
    ...overrides,
  };
}

describe("aggregateRows", () => {
  it("same variation sold in taproom (POS) + distribution (invoice) across two months -> two rows, same coaId, different channel, correct month bucketing", () => {
    const rows = aggregateRows(
      emptyInput({
        pos: [
          {
            id: "pos-1",
            netSalesCents: 10000,
            transactionDate: "2026-01-15",
            chartOfAccountsId: null,
            prefillChartOfAccountsId: "coa-beer",
            invoiceId: null,
            isEventPour: false,
            exportChannel: null,
            categoryId: null,
            variationName: null,
            quantity: 1,
          },
        ],
        invoiceLines: [
          {
            id: "inv-line-1",
            totalCents: 20000,
            invoiceDate: "2026-02-10",
            chartOfAccountsId: "coa-beer",
            bsChartOfAccountsId: null,
            plChartOfAccountsId: null,
            deliveryInvoiceId: null,
            accountMode: null,
            deliveryInvoicePaid: false,
            exportChannel: "distribution",
            volumeBbl: null,
          },
        ],
      }),
    );

    expect(rows).toHaveLength(2);

    const taproomRow = rows.find((r) => r.channel === "taproom");
    const distributionRow = rows.find((r) => r.channel === "distribution");

    expect(taproomRow).toBeDefined();
    expect(distributionRow).toBeDefined();
    expect(taproomRow!.coaId).toBe("coa-beer");
    expect(distributionRow!.coaId).toBe("coa-beer");

    expect(taproomRow!.amountCentsByMonth).toEqual({ "2026-01": 10000, "2026-02": 0 });
    expect(distributionRow!.amountCentsByMonth).toEqual({ "2026-01": 0, "2026-02": 20000 });
  });

  it("deposit line with bs_chart_of_accounts_id set, no delivery_invoice_id -> stays on BS (stranded), row retained with mappingSource intact", () => {
    const rows = aggregateRows(
      emptyInput({
        invoiceLines: [
          {
            id: "inv-line-deposit",
            totalCents: 50000,
            invoiceDate: "2026-01-05",
            chartOfAccountsId: null,
            bsChartOfAccountsId: "coa-bs-deposit",
            plChartOfAccountsId: "coa-pl-deposit",
            deliveryInvoiceId: null,
            accountMode: null,
            deliveryInvoicePaid: false,
            exportChannel: "contract_brewing",
            volumeBbl: null,
          },
        ],
      }),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].coaId).toBe("coa-bs-deposit");
    expect(rows[0].accountName).toBe("Customer Deposits");
    expect(rows[0].statementSection).toBe("other_current_liabilities");
    expect(rows[0].mappingSource).toBe("rule");
    expect(rows[0].sourceRef).toEqual({ table: "invoice_line_items", ids: ["inv-line-deposit"] });
  });

  it("deposit line recognizes to PL once its delivery invoice is paid", () => {
    const rows = aggregateRows(
      emptyInput({
        invoiceLines: [
          {
            id: "inv-line-deposit-2",
            totalCents: 30000,
            invoiceDate: "2026-01-05",
            chartOfAccountsId: null,
            bsChartOfAccountsId: "coa-bs-deposit",
            plChartOfAccountsId: "coa-pl-deposit",
            deliveryInvoiceId: "delivery-1",
            accountMode: null,
            deliveryInvoicePaid: true,
            exportChannel: "distribution",
            volumeBbl: null,
          },
        ],
      }),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].coaId).toBe("coa-pl-deposit");
    expect(rows[0].statementSection).toBe("revenue");
  });

  it("unmapped POS line (no manual override, no mapping prefill) is retained, not dropped", () => {
    const rows = aggregateRows(
      emptyInput({
        pos: [
          {
            id: "pos-unmapped",
            netSalesCents: 5000,
            transactionDate: "2026-01-20",
            chartOfAccountsId: null,
            prefillChartOfAccountsId: null,
            invoiceId: null,
            isEventPour: false,
            exportChannel: null,
            categoryId: null,
            variationName: null,
            quantity: 1,
          },
        ],
      }),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].coaId).toBeNull();
    expect(rows[0].mappingSource).toBe("unmapped");
    expect(rows[0].accountName).toBe("Unmapped");
    expect(rows[0].amountCentsByMonth["2026-01"]).toBe(5000);
  });

  it("buckets multiple line items in the same month + group into one summed amount, and correctly attaches BBL", () => {
    const rows = aggregateRows(
      emptyInput({
        pos: [
          {
            id: "pos-a",
            netSalesCents: 4000,
            transactionDate: "2026-01-03",
            chartOfAccountsId: "coa-beer",
            prefillChartOfAccountsId: null,
            invoiceId: null,
            isEventPour: false,
            exportChannel: null,
            categoryId: KEG_CAT,
            variationName: "1/2 Keg",
            quantity: 1,
          },
          {
            id: "pos-b",
            netSalesCents: 6000,
            transactionDate: "2026-01-25",
            chartOfAccountsId: "coa-beer",
            prefillChartOfAccountsId: null,
            invoiceId: null,
            isEventPour: false,
            exportChannel: null,
            categoryId: KEG_CAT,
            variationName: "1/2 Keg",
            quantity: 1,
          },
        ],
      }),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].amountCentsByMonth).toEqual({ "2026-01": 10000, "2026-02": 0 });
    expect(rows[0].kegSize).toBe("half");
    expect(rows[0].bblCoverage).toBe("full");
    expect(rows[0].bblByMonth["2026-01"]).toBeCloseTo((2 * 15.5) / 31, 10);
    expect(rows[0].bblByMonth["2026-02"]).toBe(0);
  });

  it("KEGS row with net_sales_cents 0 (keg-transfer onto tap, not a sale) contributes 0 BBL with full coverage", () => {
    const rows = aggregateRows(
      emptyInput({
        pos: [
          {
            id: "pos-transfer",
            netSalesCents: 0,
            transactionDate: "2026-01-05",
            chartOfAccountsId: "coa-beer",
            prefillChartOfAccountsId: null,
            invoiceId: null,
            isEventPour: false,
            exportChannel: null,
            categoryId: KEG_CAT,
            variationName: "1/2 Keg",
            quantity: 1,
          },
        ],
      }),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].bblByMonth["2026-01"]).toBe(0);
    expect(rows[0].bblCoverage).toBe("full");
    expect(rows[0].amountCentsByMonth["2026-01"]).toBe(0);
  });

  it("real keg sale (net_sales_cents > 0) alongside a keg-transfer in the same group only counts the real sale's BBL", () => {
    const rows = aggregateRows(
      emptyInput({
        pos: [
          {
            id: "pos-transfer-2",
            netSalesCents: 0,
            transactionDate: "2026-01-05",
            chartOfAccountsId: "coa-beer",
            prefillChartOfAccountsId: null,
            invoiceId: null,
            isEventPour: false,
            exportChannel: null,
            categoryId: KEG_CAT,
            variationName: "1/2 Keg",
            quantity: 1,
          },
          {
            id: "pos-real-sale",
            netSalesCents: 15000,
            transactionDate: "2026-01-06",
            chartOfAccountsId: "coa-beer",
            prefillChartOfAccountsId: null,
            invoiceId: null,
            isEventPour: false,
            exportChannel: null,
            categoryId: KEG_CAT,
            variationName: "1/2 Keg",
            quantity: 1,
          },
        ],
      }),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].bblByMonth["2026-01"]).toBeCloseTo(15.5 / 31, 10);
    expect(rows[0].bblCoverage).toBe("full");
    expect(rows[0].amountCentsByMonth["2026-01"]).toBe(15000);
  });

  it("filters out rows whose month falls outside the requested `months` window", () => {
    const rows = aggregateRows(
      emptyInput({
        pos: [
          {
            id: "pos-out-of-range",
            netSalesCents: 1000,
            transactionDate: "2025-12-31",
            chartOfAccountsId: "coa-beer",
            prefillChartOfAccountsId: null,
            invoiceId: null,
            isEventPour: false,
            exportChannel: null,
            categoryId: null,
            variationName: null,
            quantity: 1,
          },
        ],
      }),
    );

    expect(rows).toHaveLength(0);
  });

  it("expenses/bank/refunds use the row's own chart_of_accounts_id + mappingSource directly and normalize sign", () => {
    const rows = aggregateRows(
      emptyInput({
        expenses: [
          {
            id: "exp-1",
            chartOfAccountsId: "coa-expense",
            amountCents: -1500,
            accountingDate: "2026-01-10",
            mappingSource: "rule",
          },
        ],
        bank: [
          {
            id: "bank-1",
            chartOfAccountsId: null,
            amountCents: 500,
            transactionDate: "2026-02-01",
            mappingSource: "unmapped",
          },
        ],
        refunds: [
          {
            id: "refund-1",
            chartOfAccountsId: "coa-beer",
            amountCents: 750,
            refundedAt: "2026-01-12",
          },
        ],
      }),
    );

    expect(rows).toHaveLength(3);

    const exp = rows.find((r) => r.sourceRef.table === "expenses")!;
    expect(exp.amountCentsByMonth["2026-01"]).toBe(-1500);
    expect(exp.mappingSource).toBe("rule");

    const bank = rows.find((r) => r.sourceRef.table === "ramp_bank_ledger")!;
    expect(bank.coaId).toBeNull();
    expect(bank.mappingSource).toBe("unmapped");
    expect(bank.amountCentsByMonth["2026-02"]).toBe(500);

    const refund = rows.find((r) => r.sourceRef.table === "square_refunds")!;
    expect(refund.mappingSource).toBe("manual");
    expect(refund.amountCentsByMonth["2026-01"]).toBe(-750);
  });
});
