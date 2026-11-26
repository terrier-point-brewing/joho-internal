import { describe, it, expect } from "vitest";
import { aggregateRows, type AggregateRowsInput, type CoaRecord, type ExpenseRecord } from "./aggregateRows";
import { buildKpis } from "./summaries";
import { SERVICE_PERIOD_TABLE, deferredAfter } from "../servicePeriod";

const COA: CoaRecord[] = [
  { id: "coa-rent", parentId: null, accountName: "Rent", accountNumber: "6210", accountType: "Expenses", statementSection: null },
  { id: "coa-prepaid", parentId: null, accountName: "Prepaid Expenses", accountNumber: "1300", accountType: "Other Current Assets", statementSection: null },
];

const MONTHS = ["2026-09", "2026-10", "2026-11", "2026-12", "2027-01"];

function input(expenses: ExpenseRecord[], months = MONTHS): AggregateRowsInput {
  return { pos: [], invoiceLines: [], expenses, refunds: [], bank: [], tipAccruals: [], taxAccruals: [], coa: COA, months };
}

const TAX_BILL: ExpenseRecord = {
  id: "tax-2026",
  chartOfAccountsId: "coa-rent",
  amountCents: -829_944,
  accountingDate: "2026-11-02",
  mappingSource: "manual",
  servicePeriod: { start: "2026-01-01", end: "2026-12-31", recognise: "spread" },
};

const RENT: ExpenseRecord = { id: "rent-nov", chartOfAccountsId: "coa-rent", amountCents: -669_000, accountingDate: "2026-11-25", mappingSource: "rule" };

describe("aggregateRows: a bill spread over the months it covers", () => {
  it("catches up the months before the bill in the bill's month, defers the rest, and touches no earlier month", () => {
    const rows = aggregateRows(input([TAX_BILL]));
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.sourceRef.table).toBe(SERVICE_PERIOD_TABLE);
    expect(row.amountCentsByMonth["2026-09"]).toBe(0);
    expect(row.amountCentsByMonth["2026-10"]).toBe(0);
    expect(row.amountCentsByMonth["2026-11"]).toBe(-69_162 * 11);
    expect(row.amountCentsByMonth["2026-12"]).toBe(-69_162);
    expect(row.amountCentsByMonth["2027-01"]).toBe(0);
  });

  it("keeps the spread bill on its own row, apart from the account's ordinary spending", () => {
    const rows = aggregateRows(input([TAX_BILL, RENT]));
    expect(rows.map((r) => r.sourceRef.table).sort()).toEqual([SERVICE_PERIOD_TABLE, "expenses"].sort());
    const ordinary = rows.find((r) => r.sourceRef.table === "expenses")!;
    expect(ordinary.amountCentsByMonth["2026-11"]).toBe(-669_000);
    expect(ordinary.amountCentsByMonth["2026-12"]).toBe(0);
    // Same account either way, so the statement tree still shows one Rent line.
    expect(new Set(rows.map((r) => r.coaId))).toEqual(new Set(["coa-rent"]));
  });

  it("spreads a bill paid ahead evenly across a year end", () => {
    const rows = aggregateRows(
      input([{ ...TAX_BILL, amountCents: -120_000, servicePeriod: { start: "2026-11-01", end: "2027-10-31", recognise: "spread" } }]),
    );
    for (const m of ["2026-11", "2026-12", "2027-01"]) expect(rows[0].amountCentsByMonth[m]).toBe(-10_000);
  });

  it("charges the whole bill in the month it was paid on the cash-flow statement, still on its own row", () => {
    const rows = aggregateRows(
      input([{ ...TAX_BILL, accountingDate: "2026-12-04", servicePeriod: { ...TAX_BILL.servicePeriod!, recognise: "whenPaid" } }]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceRef.table).toBe(SERVICE_PERIOD_TABLE);
    expect(rows[0].amountCentsByMonth["2026-12"]).toBe(-829_944);
    expect(rows[0].amountCentsByMonth["2026-11"]).toBe(0);
  });

  it("does not spread a split line coded to a balance-sheet account", () => {
    const rows = aggregateRows(
      input([
        {
          ...TAX_BILL,
          chartOfAccountsId: null,
          splitLines: [
            { chartOfAccountsId: "coa-rent", amountCents: -553_296, splitSource: "manual" },
            { chartOfAccountsId: "coa-prepaid", amountCents: -276_648, splitSource: "manual" },
          ],
        },
      ]),
    );
    const balanceSheetLine = rows.find((r) => r.coaId === "coa-prepaid")!;
    expect(balanceSheetLine.sourceRef.table).toBe("expenses");
    expect(Object.values(balanceSheetLine.amountCentsByMonth).filter((c) => c !== 0)).toHaveLength(1);
    expect(balanceSheetLine.amountCentsByMonth["2026-11"]).not.toBe(0);

    const spread = rows.find((r) => r.coaId === "coa-rent")!;
    expect(spread.sourceRef.table).toBe(SERVICE_PERIOD_TABLE);
    expect(spread.amountCentsByMonth["2026-11"] + spread.amountCentsByMonth["2026-12"]).toBe(-553_296);
  });

  it("leaves an unmapped bill where it was, so it is still flagged as unmapped in its own month", () => {
    const rows = aggregateRows(input([{ ...TAX_BILL, chartOfAccountsId: null, mappingSource: "unmapped" }]));
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceRef.table).toBe("expenses");
    expect(rows[0].amountCentsByMonth["2026-11"]).toBe(-829_944);
  });

  it("lets a pay period win when an expense somehow carries both", () => {
    const rows = aggregateRows(input([{ ...TAX_BILL, payrollPeriod: { start: "2026-11-01", end: "2026-11-14" } }]));
    expect(rows[0].sourceRef.table).toBe("expenses");
    expect(rows[0].amountCentsByMonth["2026-11"]).toBe(-829_944);
  });

  it("ties: net income through any month end plus what is still prepaid equals the bill", () => {
    // Retained earnings sums this pipeline's net income through period end; the
    // Prepaid Expenses provider reports deferredAfter. Together they must
    // account for the whole bill at every month end, or the balance sheet
    // stops balancing by the difference.
    for (const through of ["2026-11", "2026-12", "2027-01"]) {
      const months = MONTHS.filter((m) => m <= through);
      const net = buildKpis(aggregateRows(input([TAX_BILL], months)), months).netIncomeCents;
      const recognised = months.reduce((sum, m) => sum + (net[m] ?? 0), 0);
      const prepaid = deferredAfter(TAX_BILL.amountCents, TAX_BILL.servicePeriod!, "2026-11", through);
      expect(recognised + prepaid).toBe(TAX_BILL.amountCents);
    }
  });
});
