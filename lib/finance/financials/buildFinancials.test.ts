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
  { id: "coa-rev", parentId: null, accountName: "Taproom Sales", accountNumber: "4000", accountType: "Income", statementSection: null },
  { id: "coa-cogs", parentId: null, accountName: "COGS", accountNumber: "5000", accountType: "Cost of Goods Sold", statementSection: null },
  { id: "coa-exp", parentId: null, accountName: "Rent", accountNumber: "6000", accountType: "Expenses", statementSection: null },
  { id: "coa-bank", parentId: null, accountName: "Operating Checking", accountNumber: "1000", accountType: "Bank", statementSection: null },
  { id: "coa-ar", parentId: null, accountName: "Accounts Receivable", accountNumber: "1100", accountType: "Accounts receivable (A/R)", statementSection: null },
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
    arAccount: null,
    openInvoiceArCents: 0,
    manualNetSalesEntries: [],
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
        arAccount: null,
        openInvoiceArCents: 0,
        manualNetSalesEntries: [],
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

  describe("open-invoice A/R (balance_sheet mode, C3)", () => {
    const AR_ACCOUNT = { id: "coa-ar", name: "Accounts Receivable" };

    it("adds the open-invoice A/R total to an already-mapped A/R account's cumulative balance", async () => {
      mockedFetch.mockImplementation(async ({ statement }: { statement: StatementKind; year: number }) => {
        expect(statement).toBe("balance_sheet");
        return {
          ...emptySources(["2026-12"]),
          invoiceLines: [
            {
              id: "inv-ar-mapped", totalCents: 20000, invoiceDate: "2026-12",
              chartOfAccountsId: "coa-ar", bsChartOfAccountsId: null, plChartOfAccountsId: null,
              deliveryInvoiceId: null, accountMode: null, deliveryInvoicePaid: false,
              exportChannel: null, volumeBbl: null,
            },
          ],
          arAccount: AR_ACCOUNT,
          // Two open invoices totaling 50000 cents.
          openInvoiceArCents: 50000,
        };
      });

      const resp = await buildFinancials({ statement: "balance_sheet", year: 2026 });

      const arRow = resp.rows.find((r) => r.coaId === "coa-ar");
      expect(arRow).toBeDefined();
      expect(arRow!.statementSection).toBe("ar");
      // 20000 already-mapped invoice line + 50000 open-invoice A/R = 70000.
      expect(arRow!.amountCentsByMonth["2026-12"]).toBe(70000);
    });

    it("synthesizes an A/R row when no invoice lines are mapped to the A/R account", async () => {
      mockedFetch.mockResolvedValue({
        ...emptySources(["2026-12"]),
        arAccount: AR_ACCOUNT,
        openInvoiceArCents: 50000,
      });

      const resp = await buildFinancials({ statement: "balance_sheet", year: 2026 });

      const arRow = resp.rows.find((r) => r.coaId === "coa-ar");
      expect(arRow).toBeDefined();
      expect(arRow).toMatchObject({
        coaId: "coa-ar",
        accountName: "Accounts Receivable",
        statementSection: "ar",
        channel: "unknown",
      });
      expect(arRow!.amountCentsByMonth["2026-12"]).toBe(50000);
    });

    it("does not inject A/R for pl or cash_flow modes even when the fetch layer returns arAccount/openInvoiceArCents", async () => {
      const months = ["2026-06"];
      mockedFetch.mockResolvedValue({
        ...emptySources(months),
        arAccount: AR_ACCOUNT,
        openInvoiceArCents: 50000,
      });

      const pl = await buildFinancials({ statement: "pl", year: 2026 });
      const cashFlow = await buildFinancials({ statement: "cash_flow", year: 2026 });

      expect(pl.rows.find((r) => r.coaId === "coa-ar")).toBeUndefined();
      expect(cashFlow.rows.find((r) => r.coaId === "coa-ar")).toBeUndefined();
    });

    it("does not add a row when openInvoiceArCents is 0", async () => {
      mockedFetch.mockResolvedValue({
        ...emptySources(["2026-12"]),
        arAccount: AR_ACCOUNT,
        openInvoiceArCents: 0,
      });

      const resp = await buildFinancials({ statement: "balance_sheet", year: 2026 });

      expect(resp.rows.find((r) => r.coaId === "coa-ar")).toBeUndefined();
    });
  });

  describe("manual_net_sales_entries proration (Square parity fix B)", () => {
    it("attributes the full amount_cents to a month an entry spans entirely, into taproom revenue and Net Income", async () => {
      const months = ["2026-05"];
      mockedFetch.mockResolvedValue({
        ...emptySources(months),
        manualNetSalesEntries: [
          { id: "m-1", startDate: "2026-05-01", endDate: "2026-05-31", amountCents: 891300 },
        ],
      });

      const resp = await buildFinancials({ statement: "pl", year: 2026 });
      const month = "2026-05";

      const manualRow = resp.rows.find((r) => r.sourceRef.table === "manual_net_sales_entries");
      expect(manualRow).toBeDefined();
      expect(manualRow!.channel).toBe("taproom");
      expect(manualRow!.statementSection).toBe("revenue");
      expect(manualRow!.coaId).toBeNull();
      expect(manualRow!.amountCentsByMonth[month]).toBe(891300);

      expect(resp.kpis.revenueCents[month]).toBe(891300);
      expect(resp.kpis.netIncomeCents[month]).toBe(891300);
    });

    it("day-weights an entry spanning only half a month into the exact fractional cents", async () => {
      // Entry spans Apr 16 - May 15 (30 inclusive days). Overlap with May
      // (2026-05, 31 days) is May 1-15 (15 inclusive days).
      // round(100000 * 15 / 30) = 50000.
      const months = ["2026-04", "2026-05"];
      mockedFetch.mockResolvedValue({
        ...emptySources(months),
        manualNetSalesEntries: [
          { id: "m-2", startDate: "2026-04-16", endDate: "2026-05-15", amountCents: 100000 },
        ],
      });

      const resp = await buildFinancials({ statement: "pl", year: 2026 });

      const manualRow = resp.rows.find((r) => r.sourceRef.table === "manual_net_sales_entries");
      expect(manualRow).toBeDefined();
      // Apr 16-30 overlap (15 inclusive days of a 30-day entry) -> 50000.
      expect(manualRow!.amountCentsByMonth["2026-04"]).toBe(50000);
      // May 1-15 overlap (15 inclusive days) -> 50000.
      expect(manualRow!.amountCentsByMonth["2026-05"]).toBe(50000);

      expect(resp.kpis.revenueCents["2026-04"]).toBe(50000);
      expect(resp.kpis.revenueCents["2026-05"]).toBe(50000);
    });

    it("excludes the synthesized manual row from the unmapped data-quality bucket despite coaId:null", async () => {
      const months = ["2026-05"];
      mockedFetch.mockResolvedValue({
        ...emptySources(months),
        manualNetSalesEntries: [
          { id: "m-3", startDate: "2026-05-01", endDate: "2026-05-31", amountCents: 891300 },
        ],
      });

      const resp = await buildFinancials({ statement: "pl", year: 2026 });

      const manualRow = resp.rows.find((r) => r.sourceRef.table === "manual_net_sales_entries");
      expect(manualRow).toBeDefined();
      expect(manualRow!.coaId).toBeNull();

      // The row is coaId:null (would otherwise count as unmapped), but the
      // deliberate top-line adjustment carve-out keeps it out of the bucket.
      expect(resp.dataQuality.unmapped.count).toBe(0);
      expect(resp.dataQuality.unmapped.cents).toBe(0);
    });

    it("does not inject a manual net-sales row for balance_sheet mode even when entries are present", async () => {
      mockedFetch.mockResolvedValue({
        ...emptySources(["2026-12"]),
        manualNetSalesEntries: [
          { id: "m-4", startDate: "2026-01-01", endDate: "2026-12-31", amountCents: 500000 },
        ],
      });

      const resp = await buildFinancials({ statement: "balance_sheet", year: 2026 });

      expect(resp.rows.find((r) => r.sourceRef.table === "manual_net_sales_entries")).toBeUndefined();
    });
  });
});
