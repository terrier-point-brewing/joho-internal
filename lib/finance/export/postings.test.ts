import { describe, it, expect } from "vitest";
import { aggregateRows, type CoaRecord } from "@/lib/finance/financials/aggregateRows";
import type { FinancialsRow } from "@/lib/finance/financials/types";
import { debitCredit, derivedLines, isDerivedRow, reconcileToStatement, resolvePostings, type PostingSources } from "./postings";

const MONTHS = ["2026-01", "2026-02"];

const COA: CoaRecord[] = [
  { id: "beer", parentId: null, accountName: "Beer Sales", accountNumber: "4000", accountType: "Income", statementSection: null },
  { id: "wages", parentId: null, accountName: "Wages", accountNumber: "6110", accountType: "Expenses", statementSection: null },
  { id: "taxes", parentId: null, accountName: "Payroll Taxes", accountNumber: "6120", accountType: "Expenses", statementSection: null },
  { id: "supplies", parentId: null, accountName: "Supplies", accountNumber: "6100", accountType: "Expenses", statementSection: null },
  { id: "equipment", parentId: null, accountName: "Equipment", accountNumber: "1500", accountType: "Fixed Assets", statementSection: null },
  { id: "deposits", parentId: null, accountName: "Equipment Deposits", accountNumber: "2420", accountType: "Other Current Liabilities", statementSection: null },
];

function pos(id: string, cents: number, date: string, coaId: string | null) {
  return {
    id,
    netSalesCents: cents,
    transactionDate: date,
    chartOfAccountsId: coaId,
    prefillChartOfAccountsId: null,
    glManuallySet: false,
    invoiceId: null,
    isEventPour: false,
    exportChannel: null,
    categoryId: null,
    variationName: null,
    quantity: 1,
  };
}

/** One of everything the P&L reads, including the cases that are not one-record-one-posting. */
const SOURCES: PostingSources = {
  coa: COA,
  pos: [
    pos("pos-1", 1200, "2026-01-05T18:00:00Z", "beer"),
    pos("pos-2", 800, "2026-02-01T01:00:00Z", "beer"),
    pos("pos-unmapped", 500, "2026-01-09T18:00:00Z", null),
    pos("pos-outside", 900, "2025-12-31T18:00:00Z", "beer"),
  ],
  invoiceLines: [
    { id: "inv-1", totalCents: 50000, invoiceDate: "2026-02-10", chartOfAccountsId: "beer", exportChannel: "distribution", volumeBbl: null },
    { id: "inv-discount", totalCents: -2700, category: "discount", invoiceDate: "2026-02-10", chartOfAccountsId: "beer", exportChannel: "distribution", volumeBbl: null },
  ],
  expenses: [
    { id: "exp-1", chartOfAccountsId: "supplies", amountCents: -4300, accountingDate: "2026-01-20", mappingSource: "rule" },
    // A payroll withdrawal: split across two accounts AND prorated over a pay
    // period that straddles the month boundary (Jan 26 - Feb 8).
    {
      id: "exp-payroll",
      chartOfAccountsId: "wages",
      amountCents: -100001,
      accountingDate: "2026-02-09",
      mappingSource: "rule",
      splitLines: [
        { chartOfAccountsId: "wages", amountCents: -90001, splitSource: "payroll_auto" },
        { chartOfAccountsId: "taxes", amountCents: -10000, splitSource: "payroll_auto" },
      ],
      payrollPeriod: { start: "2026-01-26", end: "2026-02-08" },
    },
    // Coded to a balance-sheet account: an asset purchase.
    { id: "exp-asset", chartOfAccountsId: "equipment", amountCents: -250000, accountingDate: "2026-01-11", mappingSource: "manual" },
  ],
  bank: [{ id: "bank-1", chartOfAccountsId: "supplies", amountCents: 1500, transactionDate: "2026-02-14", mappingSource: "manual" }],
  refunds: [
    { id: "refund-1", chartOfAccountsId: "beer", amountCents: 600, refundedAt: "2026-01-30T15:00:00Z" },
    { id: "refund-deposit", chartOfAccountsId: "deposits", amountCents: 5000, refundedAt: "2026-02-03T15:00:00Z" },
  ],
};

function statementRows(): FinancialsRow[] {
  return aggregateRows({ ...SOURCES, tipAccruals: [], taxAccruals: [], months: MONTHS });
}

describe("resolvePostings", () => {
  it("adds up to the statement for every account in every month", () => {
    const postings = resolvePostings(SOURCES, MONTHS);
    expect(reconcileToStatement(statementRows(), postings, [], MONTHS)).toEqual([]);
  });

  it("prorates a payroll withdrawal across its pay period and splits it across its accounts", () => {
    const payroll = resolvePostings(SOURCES, MONTHS).filter((p) => p.recordId === "exp-payroll");
    expect(payroll.map((p) => `${p.coaId}:${p.month}`).sort()).toEqual(["taxes:2026-01", "taxes:2026-02", "wages:2026-01", "wages:2026-02"]);
    // Nothing is lost to rounding: the four lines are the withdrawal.
    expect(payroll.reduce((s, p) => s + p.amountCents, 0)).toBe(-100001);
    // The record's own date is kept even though the money lands in two months.
    expect(new Set(payroll.map((p) => p.date))).toEqual(new Set(["2026-02-09"]));
  });

  it("carries the statement's sign, not the source's", () => {
    const byId = new Map(resolvePostings(SOURCES, MONTHS).map((p) => [p.recordId, p]));
    expect(byId.get("pos-1")!.amountCents).toBe(1200); // income: positive
    expect(byId.get("exp-1")!.amountCents).toBe(-4300); // cost: negative
    expect(byId.get("refund-1")!.amountCents).toBe(-600); // contra-revenue
    expect(byId.get("inv-discount")!.amountCents).toBe(-2700); // a discount stays negative
    expect(byId.get("bank-1")!.amountCents).toBe(1500); // a credit against a cost account
    expect(byId.get("exp-asset")!.amountCents).toBe(250000); // an asset acquired
  });

  it("drops a record outside the window and keeps an unmapped one", () => {
    const postings = resolvePostings(SOURCES, MONTHS);
    expect(postings.some((p) => p.recordId === "pos-outside")).toBe(false);
    const unmapped = postings.find((p) => p.recordId === "pos-unmapped")!;
    expect(unmapped.coaId).toBeNull();
    expect(unmapped.mappingSource).toBe("unmapped");
  });

  it("truncates a timestamp to its calendar day", () => {
    expect(resolvePostings(SOURCES, MONTHS).find((p) => p.recordId === "pos-1")!.date).toBe("2026-01-05");
  });
});

function derivedRow(overrides: Partial<FinancialsRow>): FinancialsRow {
  return {
    coaId: "supplies",
    parentId: null,
    accountName: "Supplies (Depreciation)",
    statementSection: "expenses",
    channel: "unknown",
    posCategory: null,
    kegSize: null,
    amountCentsByMonth: { "2026-01": -1000, "2026-02": 0 },
    bblByMonth: {},
    bblCoverage: "full",
    mappingSource: "rule",
    sourceRef: { table: "depreciation_schedules", ids: [] },
    ...overrides,
  };
}

describe("derivedLines", () => {
  const names = new Map(COA.map((c) => [c.id, c.accountName]));

  it("recognises a synthesized row by its suffixed name, not its table", () => {
    // The inventory capitalisation row reports table "expenses", like a real expense row.
    expect(isDerivedRow(derivedRow({ accountName: "Supplies (Capitalised to inventory)", sourceRef: { table: "expenses", ids: [] } }), names)).toBe(true);
    expect(isDerivedRow(derivedRow({ accountName: "Supplies", sourceRef: { table: "expenses", ids: [] } }), names)).toBe(false);
    expect(isDerivedRow(derivedRow({ coaId: null, accountName: "Unmapped" }), names)).toBe(false);
  });

  it("emits one line per non-zero month and none for aggregated rows", () => {
    const lines = derivedLines([...statementRows(), derivedRow({})], MONTHS, COA);
    expect(lines).toEqual([
      { coaId: "supplies", month: "2026-01", amountCents: -1000, description: "Supplies (Depreciation)", basis: "depreciation_schedules" },
    ]);
  });

  it("makes the detail tie again once the synthesized rows are added to both sides", () => {
    const rows = [...statementRows(), derivedRow({})];
    const postings = resolvePostings(SOURCES, MONTHS);
    expect(reconcileToStatement(rows, postings, [], MONTHS)).toHaveLength(1);
    expect(reconcileToStatement(rows, postings, derivedLines(rows, MONTHS, COA), MONTHS)).toEqual([]);
  });
});

describe("reconcileToStatement", () => {
  it("reports the account, month and both figures when the detail is short", () => {
    const postings = resolvePostings(SOURCES, MONTHS).filter((p) => p.recordId !== "exp-1");
    expect(reconcileToStatement(statementRows(), postings, [], MONTHS)).toEqual([
      { coaId: "supplies", month: "2026-01", statementCents: -4300, detailCents: 0 },
    ]);
  });

  it("reports an unmapped difference with a null account", () => {
    const postings = resolvePostings(SOURCES, MONTHS).filter((p) => p.recordId !== "pos-unmapped");
    expect(reconcileToStatement(statementRows(), postings, [], MONTHS)).toEqual([
      { coaId: null, month: "2026-01", statementCents: 500, detailCents: 0 },
    ]);
  });
});

describe("debitCredit", () => {
  it("puts income on the credit side and costs on the debit side", () => {
    expect(debitCredit(1200, "revenue")).toEqual({ debitCents: 0, creditCents: 1200 });
    expect(debitCredit(-4300, "expenses")).toEqual({ debitCents: 4300, creditCents: 0 });
    expect(debitCredit(-900, "cogs")).toEqual({ debitCents: 900, creditCents: 0 });
  });

  it("reverses for a refund of income and a credit against a cost", () => {
    expect(debitCredit(-600, "revenue")).toEqual({ debitCents: 600, creditCents: 0 });
    expect(debitCredit(1500, "expenses")).toEqual({ debitCents: 0, creditCents: 1500 });
  });

  it("puts an asset acquired on the debit side and a liability taken on on the credit side", () => {
    expect(debitCredit(250000, "fixed_assets")).toEqual({ debitCents: 250000, creditCents: 0 });
    expect(debitCredit(-5000, "other_current_liabilities")).toEqual({ debitCents: 0, creditCents: 5000 });
    // Paying a liability down is stored positive, and is a debit.
    expect(debitCredit(5000, "other_current_liabilities")).toEqual({ debitCents: 5000, creditCents: 0 });
  });

  it("treats an unmapped line as P&L", () => {
    expect(debitCredit(500, "unmapped")).toEqual({ debitCents: 0, creditCents: 500 });
  });
});
