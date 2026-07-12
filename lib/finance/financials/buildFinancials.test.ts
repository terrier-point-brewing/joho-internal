import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildFinancials } from "./buildFinancials";
import { fetchFinancialsSources } from "./fetchSources";
import type { FinancialsSourcesResult } from "./fetchSources";
import type { StatementKind } from "./types";

vi.mock("./fetchSources", () => ({
  fetchFinancialsSources: vi.fn(),
}));

const mockedFetch = vi.mocked(fetchFinancialsSources);

const COA = [
  { id: "coa-rev", parentId: null, accountName: "Taproom Sales", accountType: "Income", statementSection: null },
  { id: "coa-cogs", parentId: null, accountName: "COGS", accountType: "Cost of Goods Sold", statementSection: null },
  { id: "coa-exp", parentId: null, accountName: "Rent", accountType: "Expenses", statementSection: null },
  { id: "coa-bank", parentId: null, accountName: "Operating Checking", accountType: "Bank", statementSection: null },
];

function emptySources(months: string[]): FinancialsSourcesResult {
  return {
    pos: [],
    invoiceLines: [],
    expenses: [],
    refunds: [],
    bank: [],
    coa: COA,
    months,
    strandedDeposit: { count: 0, cents: 0 },
    exciseCoverage: { shipmentsMissingExcise: 0 },
  };
}

beforeEach(() => {
  mockedFetch.mockReset();
});

describe("buildFinancials", () => {
  it("caps months at 12 even if the fetch layer returns more", async () => {
    // 14 fabricated month keys, ascending -- exercising the cap itself, not
    // calendar correctness of what a real fetch would return.
    const fake = ["2024-11", "2024-12", ...Array.from({ length: 12 }, (_, i) => `2025-${String(i + 1).padStart(2, "0")}`)];
    mockedFetch.mockResolvedValue(emptySources(fake));

    const resp = await buildFinancials({ statement: "pl", year: 2025 });

    expect(resp.months).toHaveLength(12);
    // The cap keeps the most recent months (tail), not the earliest.
    expect(resp.months).toEqual(fake.slice(-12));
  });

  it("balance_sheet mode returns a single cumulative-Total month bucket and computes cashOnHandCents from the bank section", async () => {
    mockedFetch.mockImplementation(async ({ statement }: { statement: StatementKind; year: number }) => {
      expect(statement).toBe("balance_sheet");
      return {
        pos: [
          {
            id: "pos-1", netSalesCents: 10000, transactionDate: "2026-12",
            chartOfAccountsId: "coa-rev", prefillChartOfAccountsId: null, invoiceId: null,
            isEventPour: false, exportChannel: null, categoryId: null, variationName: null, quantity: 1,
          },
        ],
        invoiceLines: [],
        expenses: [],
        refunds: [],
        bank: [
          {
            id: "bank-1", chartOfAccountsId: "coa-bank", amountCents: 500000,
            transactionDate: "2026-12", mappingSource: "manual" as const,
          },
        ],
        coa: COA,
        months: ["2026-12"],
        strandedDeposit: { count: 0, cents: 0 },
        exciseCoverage: { shipmentsMissingExcise: 0 },
      };
    });

    const resp = await buildFinancials({ statement: "balance_sheet", year: 2026 });

    expect(resp.months).toEqual(["2026-12"]);
    expect(resp.kpis.cashOnHandCents).toBe(500000);
    expect(resp.kpis.operatingCashCents).toBeNull();
  });

  it("cash_flow mode computes operatingCashCents and excludes an unpaid invoice / uncleared expense that pl mode includes", async () => {
    const months = ["2026-06"];

    mockedFetch.mockImplementation(async ({ statement }: { statement: StatementKind; year: number }) => {
      const base = emptySources(months);
      // Simulate what the real fetchSources would return: pl sees both the
      // paid and unpaid invoice line + both the cleared and uncleared
      // expense; cash_flow's DB filters (status='paid', state='CLEARED')
      // exclude the unpaid/uncleared ones before they ever reach aggregateRows.
      const paidInvoiceLine = {
        id: "inv-paid", totalCents: 5000, invoiceDate: "2026-06-10",
        chartOfAccountsId: "coa-rev", bsChartOfAccountsId: null, plChartOfAccountsId: null,
        deliveryInvoiceId: null, accountMode: null, deliveryInvoicePaid: false,
        exportChannel: null, volumeBbl: null,
      };
      const unpaidInvoiceLine = {
        ...paidInvoiceLine, id: "inv-unpaid", totalCents: 7000,
      };
      const clearedExpense = {
        id: "exp-cleared", chartOfAccountsId: "coa-exp", amountCents: -2000,
        accountingDate: "2026-06-05", mappingSource: "manual" as const,
      };
      const unclearedExpense = {
        ...clearedExpense, id: "exp-uncleared", amountCents: -3000,
      };

      if (statement === "cash_flow") {
        return { ...base, invoiceLines: [paidInvoiceLine], expenses: [clearedExpense] };
      }
      return { ...base, invoiceLines: [paidInvoiceLine, unpaidInvoiceLine], expenses: [clearedExpense, unclearedExpense] };
    });

    const pl = await buildFinancials({ statement: "pl", year: 2026 });
    const cashFlow = await buildFinancials({ statement: "cash_flow", year: 2026 });

    // pl includes both invoice lines: 5000 + 7000 = 12000 revenue.
    expect(pl.kpis.revenueCents["2026-06"]).toBe(12000);
    // cash_flow excludes the unpaid line: only 5000.
    expect(cashFlow.kpis.revenueCents["2026-06"]).toBe(5000);

    // pl net income includes both expenses: 12000 - 2000 - 3000 = 7000.
    expect(pl.kpis.netIncomeCents["2026-06"]).toBe(7000);
    // cash_flow excludes the uncleared expense: 5000 - 2000 = 3000.
    expect(cashFlow.kpis.netIncomeCents["2026-06"]).toBe(3000);

    expect(pl.kpis.operatingCashCents).toBeNull();
    expect(cashFlow.kpis.operatingCashCents).toEqual({ "2026-06": 3000 });
  });

  it("reconciliation invariant: sum of rows by channel equals sum of rows by coaId for a month", async () => {
    const months = ["2026-06"];
    mockedFetch.mockResolvedValue({
      ...emptySources(months),
      pos: [
        {
          id: "pos-1", netSalesCents: 10000, transactionDate: "2026-06-15",
          chartOfAccountsId: "coa-rev", prefillChartOfAccountsId: null, invoiceId: null,
          isEventPour: false, exportChannel: null, categoryId: null, variationName: null, quantity: 1,
        },
      ],
      invoiceLines: [
        {
          id: "inv-1", totalCents: 8000, invoiceDate: "2026-06-10",
          chartOfAccountsId: "coa-rev", bsChartOfAccountsId: null, plChartOfAccountsId: null,
          deliveryInvoiceId: null, accountMode: null, deliveryInvoicePaid: false,
          exportChannel: "distribution", volumeBbl: null,
        },
      ],
      expenses: [
        { id: "exp-1", chartOfAccountsId: "coa-cogs", amountCents: -4000, accountingDate: "2026-06-05", mappingSource: "manual" as const },
      ],
    });

    const resp = await buildFinancials({ statement: "pl", year: 2026 });
    const month = "2026-06";

    const byChannel = new Map<string, number>();
    const byCoaId = new Map<string, number>();
    for (const row of resp.rows) {
      const amt = row.amountCentsByMonth[month] ?? 0;
      byChannel.set(row.channel, (byChannel.get(row.channel) ?? 0) + amt);
      const coaKey = row.coaId ?? "\0null";
      byCoaId.set(coaKey, (byCoaId.get(coaKey) ?? 0) + amt);
    }

    const sumByChannel = [...byChannel.values()].reduce((a, b) => a + b, 0);
    const sumByCoaId = [...byCoaId.values()].reduce((a, b) => a + b, 0);

    expect(sumByChannel).toBe(sumByCoaId);
    // Sanity: not vacuously zero.
    expect(sumByChannel).toBe(10000 + 8000 - 4000);
  });

  it("attributes an invoice's export volume ONCE across its lines, not once per volume-bearing line (fetchSources.ts fetchInvoiceLines fix)", async () => {
    // Fixture models fetchInvoiceLines' post-fix contract: an invoice with a
    // keg line + a can line gets its total export volume (3 bbl) on ONE
    // representative line and 0 on the other -- never replicated onto both.
    const months = ["2026-06"];
    mockedFetch.mockResolvedValue({
      ...emptySources(months),
      invoiceLines: [
        {
          id: "inv-line-keg", totalCents: 8000, invoiceDate: "2026-06-10",
          chartOfAccountsId: "coa-rev", bsChartOfAccountsId: null, plChartOfAccountsId: null,
          deliveryInvoiceId: null, accountMode: null, deliveryInvoicePaid: false,
          exportChannel: "distribution", volumeBbl: 3,
        },
        {
          id: "inv-line-can", totalCents: 2000, invoiceDate: "2026-06-10",
          chartOfAccountsId: "coa-cogs", bsChartOfAccountsId: null, plChartOfAccountsId: null,
          deliveryInvoiceId: null, accountMode: null, deliveryInvoicePaid: false,
          exportChannel: "distribution", volumeBbl: 0,
        },
      ],
    });

    const resp = await buildFinancials({ statement: "pl", year: 2026 });
    const month = "2026-06";

    const totalBbl = resp.rows.reduce((s, row) => s + (row.bblByMonth[month] ?? 0), 0);

    // Not 6 (3 + 3 double-counted) -- exactly the invoice's real 3 bbl.
    expect(totalBbl).toBe(3);
  });

  it("passes strandedDeposit and exciseCoverage through to dataQuality with hrefs attached", async () => {
    mockedFetch.mockResolvedValue({
      ...emptySources(["2026-06"]),
      strandedDeposit: { count: 2, cents: 15000 },
      exciseCoverage: { shipmentsMissingExcise: 3 },
    });

    const resp = await buildFinancials({ statement: "pl", year: 2026 });

    expect(resp.dataQuality.strandedDeposit).toEqual({
      count: 2, cents: 15000, href: "/finance/transactions/invoices?filter=deposit-missing-delivery",
    });
    expect(resp.dataQuality.exciseCoverage).toEqual({
      shipmentsMissingExcise: 3, href: "/finance/transactions/invoices?filter=excise-coverage",
    });
  });
});
