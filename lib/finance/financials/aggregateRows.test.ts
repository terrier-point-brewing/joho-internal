import { describe, it, expect } from "vitest";
import { aggregateRows, type AggregateRowsInput, type CoaRecord } from "./aggregateRows";
import { CATEGORY_IDS } from "@/lib/constants/categories";

const KEG_CAT = [...CATEGORY_IDS.KEGS][0];

const COA: CoaRecord[] = [
  { id: "coa-beer", parentId: null, accountName: "Beer Sales", accountNumber: "4000", accountType: "Income", statementSection: null },
  { id: "coa-bs-deposit", parentId: null, accountName: "Customer Deposits", accountNumber: "2100", accountType: "Other Current Liabilities", statementSection: null },
  { id: "coa-pl-deposit", parentId: null, accountName: "Distribution Revenue", accountNumber: "4100", accountType: "Income", statementSection: null },
  { id: "coa-expense", parentId: null, accountName: "Supplies", accountNumber: "6100", accountType: "Expenses", statementSection: null },
];

function emptyInput(overrides: Partial<AggregateRowsInput> = {}): AggregateRowsInput {
  return {
    pos: [],
    invoiceLines: [],
    expenses: [],
    refunds: [],
    bank: [],
    tipAccruals: [],
    taxAccruals: [],
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

  it("contract-brewing deposit line recognizes revenue immediately via its chart_of_accounts_id (4320), no delivery-invoice link", () => {
    const rows = aggregateRows(
      emptyInput({
        invoiceLines: [
          {
            id: "inv-line-deposit",
            totalCents: 50000,
            invoiceDate: "2026-01-05",
            // deposit lines map straight to the 4320 revenue account like any other line
            chartOfAccountsId: "coa-pl-deposit",
            exportChannel: "contract_brewing",
            volumeBbl: null,
          },
        ],
      }),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].coaId).toBe("coa-pl-deposit");
    expect(rows[0].statementSection).toBe("revenue");
    expect(rows[0].mappingSource).toBe("rule");
    expect(rows[0].sourceRef).toEqual({ table: "invoice_line_items", ids: ["inv-line-deposit"] });
  });

  it("ordinary invoice line books to its chart_of_accounts_id", () => {
    const rows = aggregateRows(
      emptyInput({
        invoiceLines: [
          {
            id: "inv-line-plain",
            totalCents: 30000,
            invoiceDate: "2026-01-05",
            chartOfAccountsId: "coa-pl-deposit",
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

  it("group with an immaterial slice of unknown-coverage revenue (< 5%) stays 'full' so $/BBL isn't withheld", () => {
    const CAN_CAT = [...CATEGORY_IDS.CANS][0];
    const rows = aggregateRows(
      emptyInput({
        months: ["2026-01"],
        pos: [
          // Known-volume cans: $1,000.00 of revenue with derivable BBL.
          {
            id: "can-full",
            netSalesCents: 100000,
            transactionDate: "2026-01-10",
            chartOfAccountsId: null,
            prefillChartOfAccountsId: "coa-beer",
            invoiceId: null,
            isEventPour: false,
            exportChannel: null,
            categoryId: CAN_CAT,
            variationName: "16oz 4-Pack",
            quantity: 4,
          },
          // One can with no variation name -> unknown coverage, only $10.00 (~1% of the group).
          {
            id: "can-unknown",
            netSalesCents: 1000,
            transactionDate: "2026-01-12",
            chartOfAccountsId: null,
            prefillChartOfAccountsId: "coa-beer",
            invoiceId: null,
            isEventPour: false,
            exportChannel: null,
            categoryId: CAN_CAT,
            variationName: null,
            quantity: 1,
          },
        ],
      }),
    );
    expect(rows).toHaveLength(1);
    // One immaterial unknown row must NOT blank the whole group's $/BBL.
    expect(rows[0].bblCoverage).toBe("full");
  });

  it("group with a material slice of unknown-coverage revenue (> 5%) is flagged 'unknown'", () => {
    const CAN_CAT = [...CATEGORY_IDS.CANS][0];
    const rows = aggregateRows(
      emptyInput({
        months: ["2026-01"],
        pos: [
          {
            id: "can-full",
            netSalesCents: 100000,
            transactionDate: "2026-01-10",
            chartOfAccountsId: null,
            prefillChartOfAccountsId: "coa-beer",
            invoiceId: null,
            isEventPour: false,
            exportChannel: null,
            categoryId: CAN_CAT,
            variationName: "16oz 4-Pack",
            quantity: 4,
          },
          // $200.00 of unknown-coverage revenue = ~17% of the group -> genuinely material.
          {
            id: "can-unknown",
            netSalesCents: 20000,
            transactionDate: "2026-01-12",
            chartOfAccountsId: null,
            prefillChartOfAccountsId: "coa-beer",
            invoiceId: null,
            isEventPour: false,
            exportChannel: null,
            categoryId: CAN_CAT,
            variationName: null,
            quantity: 1,
          },
        ],
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].bblCoverage).toBe("unknown");
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

  it("regression: an expense with no split lines produces the exact same ResolvedRow whether splitLines is omitted or an empty array", () => {
    const baseExpense = {
      id: "exp-nosplit",
      chartOfAccountsId: "coa-expense",
      amountCents: -42500,
      accountingDate: "2026-01-05",
      mappingSource: "rule" as const,
    };

    const withoutField = aggregateRows(emptyInput({ expenses: [{ ...baseExpense }] }));
    const withEmptyArray = aggregateRows(emptyInput({ expenses: [{ ...baseExpense, splitLines: [] }] }));

    expect(withoutField).toHaveLength(1);
    expect(withEmptyArray).toEqual(withoutField);

    const row = withoutField[0];
    expect(row.coaId).toBe("coa-expense");
    expect(row.amountCentsByMonth["2026-01"]).toBe(-42500);
    expect(row.mappingSource).toBe("rule");
    expect(row.sourceRef).toEqual({ table: "expenses", ids: ["exp-nosplit"] });
  });

  it("an expense with split lines produces one row per line, each with the line's own coaId/amountCents, summing to the original amount, with mappingSource mapped from splitSource", () => {
    const rows = aggregateRows(
      emptyInput({
        expenses: [
          {
            id: "exp-split",
            chartOfAccountsId: "coa-expense", // should be ignored in favor of splitLines
            amountCents: -68205, // -( -60000 + -8205 ), see splitLines below (signed outflow)
            accountingDate: "2026-01-15",
            mappingSource: "unmapped",
            splitLines: [
              { chartOfAccountsId: "coa-beer", amountCents: -60000, splitSource: "payroll_auto" },
              { chartOfAccountsId: "coa-expense", amountCents: -8205, splitSource: "manual" },
            ],
          },
        ],
      }),
    );

    expect(rows).toHaveLength(2);

    const autoRow = rows.find((r) => r.coaId === "coa-beer")!;
    expect(autoRow.mappingSource).toBe("rule");
    expect(autoRow.amountCentsByMonth["2026-01"]).toBe(-60000);
    expect(autoRow.sourceRef).toEqual({ table: "expenses", ids: ["exp-split"] });

    const manualRow = rows.find((r) => r.coaId === "coa-expense")!;
    expect(manualRow.mappingSource).toBe("manual");
    expect(manualRow.amountCentsByMonth["2026-01"]).toBe(-8205);

    const sum = autoRow.amountCentsByMonth["2026-01"] + manualRow.amountCentsByMonth["2026-01"];
    expect(sum).toBe(-68205);
  });

  it("a split expense with 3 lines across the same account still groups into 2 rows split by mappingSource", () => {
    const rows = aggregateRows(
      emptyInput({
        expenses: [
          {
            id: "exp-split-3",
            chartOfAccountsId: null,
            amountCents: -100000,
            accountingDate: "2026-02-01",
            mappingSource: "unmapped",
            splitLines: [
              { chartOfAccountsId: "coa-beer", amountCents: -40000, splitSource: "payroll_auto" },
              { chartOfAccountsId: "coa-bs-deposit", amountCents: -35000, splitSource: "payroll_auto" },
              { chartOfAccountsId: "coa-pl-deposit", amountCents: -25000, splitSource: "payroll_auto" },
            ],
          },
        ],
      }),
    );

    expect(rows).toHaveLength(3);
    // Sum no longer equals the raw split total: coa-beer/coa-pl-deposit are
    // P&L (Income) accounts, passed through unchanged (-40000, -25000), but
    // coa-bs-deposit is a Balance Sheet liability (Other Current
    // Liabilities) -- this -35000 outflow now correctly PAYS DOWN the
    // liability (+35000) instead of growing it, per the Task 5 fix. See
    // normalizeSign.ts / normalizeSign.test.ts.
    const total = rows.reduce((s, r) => s + r.amountCentsByMonth["2026-02"], 0);
    expect(total).toBe(-30000);
    for (const r of rows) expect(r.mappingSource).toBe("rule");
  });

  it("a payroll-matched expense's split line prorates across the months its pay period spans (50/50 for a 7+7 day period), regardless of when the transaction posted", () => {
    const rows = aggregateRows(
      emptyInput({
        months: ["2026-05", "2026-06"],
        expenses: [
          {
            id: "exp-payroll",
            chartOfAccountsId: null,
            amountCents: -42000,
            accountingDate: "2026-06-03", // posts in June -- attribution should still split May/June by pay period days
            mappingSource: "unmapped",
            payrollPeriod: { start: "2026-05-25", end: "2026-06-07" }, // 7 days May + 7 days June = 14
            splitLines: [{ chartOfAccountsId: "coa-expense", amountCents: -42000, splitSource: "payroll_auto" }],
          },
        ],
      }),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].amountCentsByMonth["2026-05"]).toBe(-21000);
    expect(rows[0].amountCentsByMonth["2026-06"]).toBe(-21000);
  });

  it("a payroll-matched expense whose pay period sits entirely within one month attributes to that month even when accountingDate posts in a later month", () => {
    const rows = aggregateRows(
      emptyInput({
        months: ["2026-05", "2026-06"],
        expenses: [
          {
            id: "exp-payroll-delay",
            chartOfAccountsId: "coa-expense",
            amountCents: -10000,
            accountingDate: "2026-06-02", // posted days after the period ended
            mappingSource: "rule",
            payrollPeriod: { start: "2026-05-01", end: "2026-05-14" }, // entirely May
          },
        ],
      }),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].amountCentsByMonth["2026-05"]).toBe(-10000);
    expect(rows[0].amountCentsByMonth["2026-06"] ?? 0).toBe(0);
  });

  it("multiple split lines on the same matched expense are each prorated independently, per-month sums equal each line's own amount", () => {
    const rows = aggregateRows(
      emptyInput({
        months: ["2026-05", "2026-06"],
        expenses: [
          {
            id: "exp-payroll-multi",
            chartOfAccountsId: null,
            amountCents: -68000,
            accountingDate: "2026-06-01",
            mappingSource: "unmapped",
            payrollPeriod: { start: "2026-05-25", end: "2026-06-07" }, // 7+7 days
            splitLines: [
              { chartOfAccountsId: "coa-beer", amountCents: -60000, splitSource: "payroll_auto" },
              { chartOfAccountsId: "coa-expense", amountCents: -8000, splitSource: "manual" },
            ],
          },
        ],
      }),
    );

    expect(rows).toHaveLength(2);
    const autoRow = rows.find((r) => r.coaId === "coa-beer")!;
    const manualRow = rows.find((r) => r.coaId === "coa-expense")!;

    expect(autoRow.amountCentsByMonth["2026-05"]).toBe(-30000);
    expect(autoRow.amountCentsByMonth["2026-06"]).toBe(-30000);
    expect(manualRow.amountCentsByMonth["2026-05"]).toBe(-4000);
    expect(manualRow.amountCentsByMonth["2026-06"]).toBe(-4000);
  });

  describe("tip accruals", () => {
    it("a tip accrual on an other_current_liabilities account resolves to negative signed cents (credits the liability)", () => {
      const rows = aggregateRows(
        emptyInput({
          tipAccruals: [{ id: "tips-2026-01", chartOfAccountsId: "coa-bs-deposit", amountCents: 204354, monthKey: "2026-01" }],
        }),
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].coaId).toBe("coa-bs-deposit");
      expect(rows[0].amountCentsByMonth["2026-01"]).toBe(-204354);
      expect(rows[0].mappingSource).toBe("rule");
      expect(rows[0].channel).toBe("unknown");
    });

    it("a tip accrual whose monthKey is outside `months` is dropped", () => {
      const rows = aggregateRows(
        emptyInput({
          months: ["2026-01", "2026-02"],
          tipAccruals: [{ id: "tips-2025-12", chartOfAccountsId: "coa-bs-deposit", amountCents: 100000, monthKey: "2025-12" }],
        }),
      );

      expect(rows).toHaveLength(0);
    });

    it("an accrual and a payout on the same liability account in the same month OFFSET rather than compound", () => {
      const rows = aggregateRows(
        emptyInput({
          months: ["2026-06"],
          expenses: [
            // Payout: cash leaves to pay employees out their collected tips.
            { id: "exp-tip-payout", chartOfAccountsId: "coa-bs-deposit", amountCents: -190000, accountingDate: "2026-06-15", mappingSource: "manual" },
          ],
          tipAccruals: [
            // Collection: that same month's card tips collected.
            { id: "tips-2026-06", chartOfAccountsId: "coa-bs-deposit", amountCents: 190000, monthKey: "2026-06" },
          ],
        }),
      );

      const total = rows
        .filter((r) => r.coaId === "coa-bs-deposit")
        .reduce((s, r) => s + (r.amountCentsByMonth["2026-06"] ?? 0), 0);

      // Payout (-190000 raw -> +190000, pays the liability down) and accrual
      // (+190000 raw -> -190000, credits the liability back up) are equal and
      // opposite -- net liability movement for the month is 0. If the signs
      // compounded instead of offsetting, this would be -380000 or +380000.
      expect(total).toBe(0);
    });
  });

  it("posts a tax accrual negative onto its liability account", () => {
    const rows = aggregateRows({
      pos: [], invoiceLines: [], expenses: [], refunds: [], bank: [], tipAccruals: [],
      taxAccruals: [{ id: "tax-COA_TAX-2026-07", chartOfAccountsId: "COA_TAX", amountCents: 288732, monthKey: "2026-07" }],
      coa: [{ id: "COA_TAX", parentId: null, accountName: "Sales & Excise Taxes Payable:Sales Tax Payable", accountNumber: null, accountType: "Other Current Liabilities", statementSection: null }],
      months: ["2026-07"],
    });
    const row = rows.find((r) => r.coaId === "COA_TAX");
    expect(row?.amountCentsByMonth["2026-07"]).toBe(-288732);
    expect(row?.statementSection).toBe("other_current_liabilities");
  });
});
