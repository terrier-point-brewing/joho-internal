import { describe, it, expect } from "vitest";
import { aggregateRows } from "@/lib/finance/financials/aggregateRows";
import type { FinancialsResponse, FinancialsRow } from "@/lib/finance/financials/types";
import { derivedLines, reconcileToStatement, resolvePostings, type PostingSources } from "./postings";
import { buildExportSheets, derivedDescription, monthEndDate, monthLabel, type CoaDetail, type ExportData } from "./workbook";
import { parseExportYear } from "./parseParams";
import type { Cell, Sheet } from "./xlsx";

const MONTHS = ["2026-01", "2026-02"];

function account(id: string, number: string, name: string, type: string, parentId: string | null = null): CoaDetail {
  return { id, parentId, accountName: name, accountNumber: number, accountType: type, statementSection: null, excluded: false, detailType: null, description: null, isActive: true };
}

const COA: CoaDetail[] = [
  account("revenue", "4000", "Brewery Revenue", "Income"),
  account("beer", "4100", "Beer Sales", "Income", "revenue"),
  account("supplies", "6100", "Supplies", "Expenses"),
  account("cash", "1010", "Checking", "Bank"),
  account("ap", "2000", "Accounts Payable", "Accounts payable (A/P)"),
];

const SOURCES: PostingSources = {
  coa: COA,
  pos: [
    { id: "pos-1", netSalesCents: 10000, transactionDate: "2026-01-05T18:00:00Z", chartOfAccountsId: "beer", prefillChartOfAccountsId: null, glManuallySet: false, invoiceId: null, isEventPour: false, exportChannel: null, categoryId: null, variationName: null, quantity: 1 },
  ],
  invoiceLines: [{ id: "inv-1", totalCents: 30000, invoiceDate: "2026-02-10", chartOfAccountsId: "beer", exportChannel: "distribution", volumeBbl: null }],
  expenses: [{ id: "exp-1", chartOfAccountsId: "supplies", amountCents: -4000, accountingDate: "2026-01-20", mappingSource: "rule" }],
  bank: [],
  refunds: [],
};

function response(rows: FinancialsRow[]): FinancialsResponse {
  return {
    months: MONTHS,
    rows,
    coaAccounts: COA.map((c) => ({ id: c.id, parentId: c.parentId, accountName: c.accountName, accountNumber: c.accountNumber, statementSection: c.accountType === "Income" ? "revenue" : c.accountType === "Expenses" ? "expenses" : c.accountType === "Bank" ? "bank" : "ap" })),
    dataQuality: {
      unmapped: { count: 0, cents: 0, href: "" },
      unmappedByPlace: [],
      uncategorized: { count: 0, cents: 0, href: "" },
      unknownVolume: { count: 0, cents: 0, href: "" },
      exciseCoverage: { shipmentsMissingExcise: 0, href: "" },
      unmappedTaxes: { count: 0, cents: 0, href: "" },
      unsourcedAccounts: { count: 0, href: "" },
    },
    kpis: { netIncomeCents: {}, grossMarginPct: {}, revenueCents: {}, revenueMoMPct: {}, operatingCashCents: null, cashOnHandCents: null },
  };
}

function balanceRow(coaId: string, name: string, section: string, jan: number, feb: number): FinancialsRow {
  return {
    coaId, parentId: null, accountName: name, statementSection: section, channel: "unknown", posCategory: null, kegSize: null,
    amountCentsByMonth: { "2026-01": jan, "2026-02": feb }, bblByMonth: {}, bblCoverage: "full", mappingSource: "rule",
    sourceRef: { table: "gl_account_balances", ids: [coaId] },
  };
}

function exportData(overrides: Partial<ExportData> = {}): ExportData {
  const plRows = aggregateRows({ ...SOURCES, tipAccruals: [], taxAccruals: [], months: MONTHS });
  const postings = resolvePostings(SOURCES, MONTHS);
  const derived = derivedLines(plRows, MONTHS, COA);
  return {
    year: 2026,
    generatedAt: "2026-03-01T12:00:00.000Z",
    asOfDate: "2026-02-28",
    pl: response(plRows),
    // Liabilities are stored negative internally.
    balanceSheet: response([balanceRow("cash", "Checking", "bank", 50000, 70000), balanceRow("ap", "Accounts Payable", "ap", -8000, -9000)]),
    cashFlow: response(plRows),
    coa: COA,
    postings,
    derived,
    differences: reconcileToStatement(plRows, postings, derived, MONTHS),
    details: new Map([
      ["pos-1", { description: "Pint - Lager", counterparty: "", reference: "ORDER1" }],
      ["inv-1", { description: "Half keg", counterparty: "Bottle Shop", reference: "Invoice 000012" }],
      ["exp-1", { description: "card - hoses", counterparty: "Brew Supply Co", reference: "RAMP1" }],
    ]),
    openInvoices: [{ invoiceNumber: "000012", invoiceDate: "2026-02-10", dueDate: "2026-03-10", customerName: "Bottle Shop", status: "open", totalCents: 30000 }],
    openBills: [{ vendor: "Malt Co", billDate: "2026-02-20", memo: null, accountId: "supplies", amountCents: 9000 }],
    manualEntries: [{ kind: "flow", label: "Cash sales", accountId: "beer", startDate: "2026-01-01", endDate: "2026-01-31", asOfDate: null, amountCents: 1200, note: null }],
    ...overrides,
  };
}

const value = (cell: Cell | undefined): string | number | null =>
  cell !== null && cell !== undefined && typeof cell === "object" ? cell.v : (cell ?? null);
const sheetNamed = (sheets: Sheet[], name: string): Sheet => sheets.find((s) => s.name === name)!;
const rowLabelled = (sheet: Sheet, label: string): Cell[] => sheet.rows.find((r) => String(value(r[0]) ?? "").trim() === label)!;

describe("date labels", () => {
  it("names a month and finds its last day, leap years included", () => {
    expect(monthLabel("2026-03")).toBe("Mar 2026");
    expect(monthEndDate("2026-02")).toBe("2026-02-28");
    expect(monthEndDate("2028-02")).toBe("2028-02-29");
    expect(monthEndDate("2026-12")).toBe("2026-12-31");
  });
});

describe("derivedDescription", () => {
  it("keeps only what the row is, since the account has its own column", () => {
    expect(derivedDescription("Raw Materials (Cost of beer sold)", "Raw Materials")).toBe("Cost of beer sold");
    expect(derivedDescription("Beer Sales (Manual Adjustment)", "Beer Sales")).toBe("Manual Adjustment");
  });

  it("leaves a name it cannot take apart alone", () => {
    expect(derivedDescription("Depreciation", undefined)).toBe("Depreciation");
    expect(derivedDescription("Depreciation", "Supplies")).toBe("Depreciation");
    expect(derivedDescription("Supplies", "Supplies")).toBe("Supplies");
  });
});

describe("parseExportYear", () => {
  it("accepts a plausible year and nothing else", () => {
    expect(parseExportYear(new URLSearchParams("year=2026"))).toEqual({ ok: true, year: 2026 });
    for (const bad of ["", "year=", "year=abc", "year=1999", "year=2026.5"]) {
      expect(parseExportYear(new URLSearchParams(bad)).ok).toBe(false);
    }
  });
});

describe("buildExportSheets", () => {
  const sheets = buildExportSheets(exportData());

  it("produces the tabs in reading order", () => {
    expect(sheets.map((s) => s.name)).toEqual([
      "Summary", "Profit & Loss", "Balance Sheet", "Cash Flow", "Account Summary", "GL Detail", "Chart of Accounts", "Open Invoices", "Open Bills", "Manual Entries",
    ]);
  });

  it("shows the P&L in dollars with a sum, rolling a sub-account into its parent", () => {
    const pl = sheetNamed(sheets, "Profit & Loss");
    expect(pl.rows[2].map(value)).toEqual(["Account", "GL #", "Jan 2026", "Feb 2026", "Total"]);
    expect(rowLabelled(pl, "Beer Sales").map(value)).toEqual(["        Beer Sales", "4100", 100, 300, 400]);
    expect(rowLabelled(pl, "Brewery Revenue").map(value).slice(1)).toEqual(["4000", 100, 300, 400]);
    expect(rowLabelled(pl, "Supplies").map(value).slice(2)).toEqual([-40, 0, -40]);
  });

  it("does not repeat an account as its channel slices", () => {
    const labels = sheetNamed(sheets, "Profit & Loss").rows.map((r) => String(value(r[0]) ?? "").trim());
    // Beer Sales has a taproom and a distribution slice on screen; neither is a line here.
    expect(labels).not.toContain("Taproom");
    expect(labels).not.toContain("Distribution");
    expect(labels.filter((l) => l === "Beer Sales")).toHaveLength(1);
  });

  it("shows the balance sheet's closing balance, with liabilities positive", () => {
    const bs = sheetNamed(sheets, "Balance Sheet");
    expect(value(bs.rows[2][4])).toBe("Balance");
    expect(rowLabelled(bs, "Checking").map(value).slice(2)).toEqual([500, 700, 700]);
    expect(rowLabelled(bs, "Accounts Payable").map(value).slice(2)).toEqual([80, 90, 90]);
  });

  it("summarises each account once: activity for the P&L, closing balance for the balance sheet", () => {
    const summary = sheetNamed(sheets, "Account Summary");
    const byNumber = new Map(summary.rows.slice(3).map((r) => [value(r[0]), r.map(value)]));
    expect(byNumber.get("4100")!.slice(4)).toEqual([400, null]);
    expect(byNumber.get("6100")!.slice(4)).toEqual([-40, null]);
    expect(byNumber.get("1010")!.slice(4)).toEqual([null, 700]);
    expect(byNumber.get("2000")!.slice(4)).toEqual([null, 90]);
    // The grouping account has no postings of its own, so it is not a line.
    expect(byNumber.has("4000")).toBe(false);
  });

  it("lists every posting on GL Detail, by account then date, with its side", () => {
    const detail = sheetNamed(sheets, "GL Detail").rows.slice(3).map((r) => r.map(value));
    expect(detail.map((r) => [r[0], r[2], r[5], r[6], r[7], r[11], r[12], r[13]])).toEqual([
      ["2026-01-05", "4100", "Square sale", "Pint - Lager", "", null, 100, 100],
      ["2026-02-10", "4100", "Invoice", "Half keg", "Bottle Shop", null, 300, 300],
      ["2026-01-20", "6100", "Expense / bill", "card - hoses", "Brew Supply Co", 40, null, -40],
    ]);
  });

  it("GL Detail's Amount column adds up to the P&L's net income", () => {
    const amounts = sheetNamed(sheets, "GL Detail").rows.slice(3).map((r) => Number(value(r[13])));
    const netIncome = rowLabelled(sheetNamed(sheets, "Profit & Loss"), "Net Income").map(value);
    expect(amounts.reduce((s, n) => s + n, 0)).toBeCloseTo(Number(netIncome[netIncome.length - 1]), 2);
  });

  it("reports the checks as passed when they pass", () => {
    const summary = sheetNamed(sheets, "Summary");
    expect(rowLabelled(summary, "GL Detail adds up to the Profit & Loss").map(value)[1]).toBe("Yes, for every account in every month");
    expect(rowLabelled(summary, "Every transaction has an account").map(value)[1]).toBe("Yes");
    expect(rowLabelled(summary, "Period").map(value)[1]).toBe("Jan 2026 to Feb 2026");
  });

  it("totals the open items", () => {
    const invoices = sheetNamed(sheets, "Open Invoices");
    expect(rowLabelled(invoices, "Total").map(value)[5]).toBe(300);
    const bills = sheetNamed(sheets, "Open Bills");
    expect(rowLabelled(bills, "Malt Co").map(value)).toEqual(["Malt Co", "2026-02-20", "6100", "Supplies", null, 90]);
    expect(rowLabelled(bills, "Total").map(value)[5]).toBe(90);
  });
});

describe("buildExportSheets with an unmapped line", () => {
  const base = exportData();
  const postings = [
    ...base.postings,
    // mappingSource "manual" with no account: a bank line deliberately left unmapped.
    { source: "bank_ledger" as const, recordId: "bank-x", coaId: null, month: "2026-02", amountCents: 50000, date: "2026-02-03", mappingSource: "manual" as const, channel: "unknown" },
  ];
  const sheets = buildExportSheets(exportData({ postings }));

  it("lists it last on GL Detail, labelled Unmapped", () => {
    const detail = sheetNamed(sheets, "GL Detail").rows.slice(3).map((r) => r.map(value));
    const last = detail[detail.length - 1];
    expect([last[2], last[3], last[10], last[13]]).toEqual([null, "Unmapped", "Unmapped", 500]);
  });

  it("reports the same count and total on the Summary", () => {
    const row = rowLabelled(sheetNamed(sheets, "Summary"), "Every transaction has an account").map(value);
    expect(String(row[1])).toMatch(/^No: 1 lines have no account/);
    expect(row[2]).toBe(500);
  });
});

describe("buildExportSheets when the detail does not tie", () => {
  // A posting has gone missing between the statement and the detail.
  const base = exportData();
  const postings = base.postings.filter((p) => p.recordId !== "exp-1");
  const sheets = buildExportSheets(
    exportData({ postings, differences: reconcileToStatement(base.pl.rows, postings, base.derived, MONTHS) }),
  );

  it("says so on the Summary, with the size of the gap", () => {
    const row = rowLabelled(sheetNamed(sheets, "Summary"), "GL Detail adds up to the Profit & Loss").map(value);
    expect(String(row[1])).toMatch(/^No: 1 account-months differ/);
    expect(row[2]).toBe(40);
  });

  it("carries the gap as its own line so the tab still adds up to the statement", () => {
    const detail = sheetNamed(sheets, "GL Detail").rows.slice(3).map((r) => r.map(value));
    const gap = detail.find((r) => r[5] === "Unreconciled")!;
    expect([gap[0], gap[2], gap[13]]).toEqual(["2026-01-31", "6100", -40]);
    expect(detail.reduce((s, r) => s + Number(r[13]), 0)).toBeCloseTo(360, 2);
  });
});
