import { describe, it, expect } from "vitest";
import { buildTree } from "./buildTree";
import type { FinancialsRow } from "@/lib/finance/financials/types";

function row(
  overrides: Partial<FinancialsRow> & {
    coaId: string | null;
    accountName: string;
    statementSection: string;
    amountCentsByMonth: Record<string, number>;
  },
): FinancialsRow {
  return {
    parentId: null,
    channel: "unknown",
    posCategory: null,
    kegSize: null,
    bblByMonth: Object.fromEntries(Object.keys(overrides.amountCentsByMonth).map((m) => [m, 0])),
    bblCoverage: "full",
    mappingSource: "manual",
    sourceRef: { table: "test", ids: [overrides.coaId ?? "unmapped"] },
    ...overrides,
  };
}

describe("buildTree — pl", () => {
  const rows: FinancialsRow[] = [
    row({
      coaId: "rev-1", accountName: "Draft Sales", statementSection: "revenue", channel: "taproom",
      amountCentsByMonth: { "2026-01": 10000, "2026-02": 12000 },
    }),
    row({
      coaId: "rev-1", accountName: "Draft Sales", statementSection: "revenue", channel: "distribution",
      amountCentsByMonth: { "2026-01": 5000, "2026-02": 4000 },
    }),
    row({
      coaId: "cogs-1", accountName: "Ingredients", statementSection: "cogs",
      amountCentsByMonth: { "2026-01": -3000, "2026-02": -3500 },
    }),
    row({
      coaId: "opex-1", accountName: "Rent", statementSection: "expenses",
      amountCentsByMonth: { "2026-01": -2000, "2026-02": -2000 },
    }),
  ];

  const tree = buildTree(rows, "pl");

  it("builds the 9 pl section/subtotal nodes in order (incl. the M1 'Other' catch-all)", () => {
    expect(tree.map((n) => n.label)).toEqual([
      "Revenue", "Other Income", "Total Income",
      "Cost of Goods Sold", "Gross Profit",
      "Operating Expenses", "Other Expenses", "Other", "Net Income",
    ]);
    expect(tree.map((n) => n.isSection)).toEqual([
      true, true, false, true, false, true, true, true, false,
    ]);
  });

  it("nests channel slice rows under their account (sorted by channel key)", () => {
    const revenue = tree[0];
    expect(revenue.children).toHaveLength(1); // one coaId -> one account
    const draftSales = revenue.children[0];
    expect(draftSales.label).toBe("Draft Sales");
    expect(draftSales.children).toHaveLength(2); // 2 distinct channels -> sliced
    expect(draftSales.children.map((c) => c.row?.channel)).toEqual(["distribution", "taproom"]);
    expect(draftSales.children[0].row?.amountCentsByMonth).toEqual({ "2026-01": 5000, "2026-02": 4000 });
    expect(draftSales.children[1].row?.amountCentsByMonth).toEqual({ "2026-01": 10000, "2026-02": 12000 });
    // account's own row is the rolled-up total across slices, not summed again by the caller
    expect(draftSales.row?.amountCentsByMonth).toEqual({ "2026-01": 15000, "2026-02": 16000 });
  });

  it("does not slice a single-channel account", () => {
    const cogs = tree[3];
    const ingredients = cogs.children[0];
    expect(ingredients.children).toHaveLength(0);
    expect(ingredients.row?.amountCentsByMonth).toEqual({ "2026-01": -3000, "2026-02": -3500 });
  });

  it("computes section totals as the sum of their root accounts", () => {
    const revenue = tree[0];
    expect(revenue.row?.amountCentsByMonth).toEqual({ "2026-01": 15000, "2026-02": 16000 });
  });

  it("computes subtotal rows by summing sign-normalized section totals (straight addition)", () => {
    const [, , totalIncome, , grossProfit, , , , netIncome] = tree;
    expect(totalIncome.row?.amountCentsByMonth).toEqual({ "2026-01": 15000, "2026-02": 16000 });
    expect(grossProfit.row?.amountCentsByMonth).toEqual({ "2026-01": 12000, "2026-02": 12500 });
    expect(netIncome.row?.amountCentsByMonth).toEqual({ "2026-01": 10000, "2026-02": 10500 });
  });

  it("subtotal nodes carry no children (their sections already rendered the detail)", () => {
    const [, , totalIncome, , grossProfit, , , , netIncome] = tree;
    expect(totalIncome.children).toHaveLength(0);
    expect(grossProfit.children).toHaveLength(0);
    expect(netIncome.children).toHaveLength(0);
  });

  it("empty sections (no matching rows) return a zeroed row and no children", () => {
    const otherIncome = tree[1];
    expect(otherIncome.children).toHaveLength(0);
    expect(otherIncome.row?.amountCentsByMonth).toEqual({ "2026-01": 0, "2026-02": 0 });
  });
});

// I1 fix (Task 15 final review): Gross Profit must exclude Other Income so it
// never disagrees with the grossMarginPct KPI (lib/finance/financials/
// summaries.ts's buildKpis, which is (revenue - cogs) / revenue with no
// other_income term -- spec §7). Total Income still includes other_income;
// Net Income still includes everything.
describe("buildTree — pl, Gross Profit excludes Other Income (I1)", () => {
  const rows: FinancialsRow[] = [
    row({
      coaId: "rev-1", accountName: "Draft Sales", statementSection: "revenue",
      amountCentsByMonth: { "2026-01": 15000 },
    }),
    row({
      coaId: "cogs-1", accountName: "Ingredients", statementSection: "cogs",
      amountCentsByMonth: { "2026-01": -3000 },
    }),
    row({
      coaId: "oi-1", accountName: "Interest Income", statementSection: "other_income",
      amountCentsByMonth: { "2026-01": 500 },
    }),
  ];

  const tree = buildTree(rows, "pl");

  it("Gross Profit == revenue - COGS, excluding a non-zero Other Income", () => {
    const [, , totalIncome, , grossProfit, , , , netIncome] = tree;
    expect(totalIncome.row?.amountCentsByMonth["2026-01"]).toBe(15500); // includes other_income
    expect(grossProfit.row?.amountCentsByMonth["2026-01"]).toBe(12000); // 15000 - 3000, excludes other_income
    expect(netIncome.row?.amountCentsByMonth["2026-01"]).toBe(12500); // still includes everything
  });
});

describe("buildTree — pl parent/child COA accounts", () => {
  const rows: FinancialsRow[] = [
    row({
      coaId: "parent-1", accountName: "Kegs", statementSection: "revenue", channel: "taproom",
      amountCentsByMonth: { "2026-01": 1000 },
    }),
    row({
      coaId: "child-1", parentId: "parent-1", accountName: "Kegs:Half", statementSection: "revenue", channel: "taproom",
      amountCentsByMonth: { "2026-01": 500 },
    }),
  ];

  const tree = buildTree(rows, "pl");
  const revenue = tree[0];

  it("nests the child COA account under its parent, not as a section root", () => {
    expect(revenue.children).toHaveLength(1);
    const parent = revenue.children[0];
    expect(parent.label).toBe("Kegs");
    expect(parent.depth).toBe(1);
    expect(parent.children).toHaveLength(1);
    const child = parent.children[0];
    // Child repeats the parent's name as a QuickBooks-style prefix -- shown
    // shortened since the parent is already visible one row up.
    expect(child.label).toBe("Half");
    expect(child.depth).toBe(2);
  });

  it("rolls the parent's own postings + child postings into the parent's row (additive, no double count)", () => {
    const parent = revenue.children[0];
    expect(parent.row?.amountCentsByMonth).toEqual({ "2026-01": 1500 });
    const child = parent.children[0];
    expect(child.row?.amountCentsByMonth).toEqual({ "2026-01": 500 });
    // Section total = sum of ROOT accounts only -- the child's amount is
    // already folded into parent.row, so no double count at the section level.
    expect(revenue.row?.amountCentsByMonth).toEqual({ "2026-01": 1500 });
  });
});

describe("buildTree — pl child label shortening", () => {
  function treeWithChild(parentName: string, childName: string) {
    const rows: FinancialsRow[] = [
      row({ coaId: "p", accountName: parentName, statementSection: "expenses", amountCentsByMonth: { "2026-01": -100 } }),
      row({ coaId: "c", parentId: "p", accountName: childName, statementSection: "expenses", amountCentsByMonth: { "2026-01": -50 } }),
    ];
    const tree = buildTree(rows, "pl");
    const opEx = tree.find((n) => n.label === "Operating Expenses")!;
    return opEx.children[0].children[0].label;
  }

  it("strips a colon-separated parent prefix", () => {
    expect(treeWithChild("Utilities", "Utilities:Electric")).toBe("Electric");
  });

  it("strips a dash-separated parent prefix (with surrounding spaces)", () => {
    expect(treeWithChild("Utilities", "Utilities - Electric")).toBe("Electric");
  });

  it("strips a bare-space-separated parent prefix", () => {
    expect(treeWithChild("Utilities", "Utilities Electric")).toBe("Electric");
  });

  it("is case-insensitive when matching the prefix", () => {
    expect(treeWithChild("Utilities", "utilities:Electric")).toBe("Electric");
  });

  it("falls back to the full name when the child doesn't start with the parent's name", () => {
    expect(treeWithChild("Utilities", "Electric Bill")).toBe("Electric Bill");
  });

  it("falls back to the full name when stripping would leave nothing (identical names)", () => {
    expect(treeWithChild("Utilities", "Utilities")).toBe("Utilities");
  });

  it("does not shorten a root account's own label (no parent to strip)", () => {
    const rows: FinancialsRow[] = [
      row({ coaId: "root-1", accountName: "Utilities:Electric", statementSection: "expenses", amountCentsByMonth: { "2026-01": -100 } }),
    ];
    const tree = buildTree(rows, "pl");
    const opEx = tree.find((n) => n.label === "Operating Expenses")!;
    expect(opEx.children[0].label).toBe("Utilities:Electric");
  });
});

describe("buildTree — balance_sheet", () => {
  const rows: FinancialsRow[] = [
    row({ coaId: "bank-1", accountName: "Checking", statementSection: "bank", amountCentsByMonth: { "2026-01": 100000 } }),
    row({ coaId: "ar-1", accountName: "AR", statementSection: "ar", amountCentsByMonth: { "2026-01": 20000 } }),
    row({ coaId: "fixed-1", accountName: "Equipment", statementSection: "fixed_assets", amountCentsByMonth: { "2026-01": 50000 } }),
    row({ coaId: "ap-1", accountName: "AP", statementSection: "ap", amountCentsByMonth: { "2026-01": -15000 } }),
    row({ coaId: "eq-1", accountName: "Owner Equity", statementSection: "equity", amountCentsByMonth: { "2026-01": -155000 } }),
  ];

  const tree = buildTree(rows, "balance_sheet");

  it("builds the 15 balance-sheet section/subtotal nodes in order (incl. the M1 'Other' catch-all)", () => {
    expect(tree.map((n) => n.label)).toEqual([
      "Bank & Cash", "Accounts Receivable", "Other Current Assets", "Total Current Assets",
      "Fixed Assets", "Total Assets",
      "Accounts Payable", "Credit Cards", "Other Current Liabilities", "Total Current Liabilities",
      "Long-Term Liabilities", "Total Liabilities",
      "Equity", "Other", "Total Liabilities + Equity",
    ]);
  });

  it("rolls current-asset sections into Total Current Assets, then adds Fixed Assets into Total Assets", () => {
    const totalCurrentAssets = tree[3];
    const totalAssets = tree[5];
    expect(totalCurrentAssets.row?.amountCentsByMonth["2026-01"]).toBe(120000);
    expect(totalAssets.row?.amountCentsByMonth["2026-01"]).toBe(170000);
  });

  it("rolls liability sections + equity into Total Liabilities + Equity", () => {
    const totalLiab = tree[11];
    const totalLE = tree[14];
    expect(totalLiab.row?.amountCentsByMonth["2026-01"]).toBe(-15000);
    expect(totalLE.row?.amountCentsByMonth["2026-01"]).toBe(-170000);
  });

  it("balances: Total Assets + Total Liabilities + Equity nets to zero under the signed-cents convention", () => {
    const totalAssets = tree[5];
    const totalLE = tree[14];
    expect((totalAssets.row?.amountCentsByMonth["2026-01"] ?? 0) + (totalLE.row?.amountCentsByMonth["2026-01"] ?? 0)).toBe(0);
  });
});

describe("buildTree — cash_flow", () => {
  const rows: FinancialsRow[] = [
    row({ coaId: "rev-1", accountName: "Sales", statementSection: "revenue", channel: "taproom", amountCentsByMonth: { "2026-01": 10000 } }),
    row({ coaId: "cogs-1", accountName: "COGS", statementSection: "cogs", amountCentsByMonth: { "2026-01": -3000 } }),
    row({ coaId: "exp-1", accountName: "Rent", statementSection: "expenses", amountCentsByMonth: { "2026-01": -2000 } }),
  ];

  const tree = buildTree(rows, "cash_flow");

  it("uses Cash In / Cash Out / Net Operating labels, MoM structured like pl", () => {
    expect(tree.map((n) => n.label)).toEqual([
      "Cash Collected — Revenue", "Cash Collected — Other Income", "Total Cash In",
      "Cash Paid — Cost of Goods Sold", "Cash Paid — Operating Expenses", "Cash Paid — Other Expenses", "Total Cash Out",
      "Other", "Net Operating",
    ]);
  });

  it("computes Total Cash In / Total Cash Out / Net Operating", () => {
    const [, , totalCashIn, , , , totalCashOut, , netOperating] = tree;
    expect(totalCashIn.row?.amountCentsByMonth["2026-01"]).toBe(10000);
    expect(totalCashOut.row?.amountCentsByMonth["2026-01"]).toBe(-5000);
    expect(netOperating.row?.amountCentsByMonth["2026-01"]).toBe(5000);
  });
});

describe("buildTree — edge cases", () => {
  it("returns zeroed sections for an empty rows array, per statement kind", () => {
    expect(buildTree([], "pl")).toHaveLength(9);
    expect(buildTree([], "cash_flow")).toHaveLength(9);
    expect(buildTree([], "balance_sheet")).toHaveLength(15);
  });

  it("groups unmapped (coaId null) rows by accountName into separate root accounts", () => {
    const rows: FinancialsRow[] = [
      row({ coaId: null, accountName: "Unmapped A", statementSection: "revenue", amountCentsByMonth: { "2026-01": 100 } }),
      row({ coaId: null, accountName: "Unmapped B", statementSection: "revenue", amountCentsByMonth: { "2026-01": 200 } }),
    ];
    const tree = buildTree(rows, "pl");
    const revenue = tree[0];
    expect(revenue.children).toHaveLength(2);
    expect(revenue.children.map((c) => c.label).sort()).toEqual(["Unmapped A", "Unmapped B"]);
  });
});

// M1 fix (review finding): a row with a non-null coaId (i.e. it IS mapped to
// a CoA account) whose statementSection isn't one of buildTree's known
// sections -- e.g. aggregateRows.ts's coaSection fallback for an
// unrecognized/missing CoA accountType -- must still render (under "Other")
// and must still count toward the bottom-line total, instead of being
// silently dropped from both the statement and Net Income.
describe("buildTree — M1: unrecognized statementSection renders under 'Other' and counts toward Net Income", () => {
  it("pl: a mapped row with a bogus statementSection appears under 'Other' and is included in Net Income", () => {
    const rows: FinancialsRow[] = [
      row({
        coaId: "rev-1", accountName: "Draft Sales", statementSection: "revenue", channel: "taproom",
        amountCentsByMonth: { "2026-01": 10000 },
      }),
      row({
        coaId: "mystery-1", accountName: "Mystery Account", statementSection: "not_a_real_section",
        amountCentsByMonth: { "2026-01": 4200 },
      }),
    ];

    const tree = buildTree(rows, "pl");
    const other = tree.find((n) => n.label === "Other")!;
    const netIncome = tree.find((n) => n.label === "Net Income")!;

    // Rendered, not dropped: shows up as an account under "Other".
    expect(other.children).toHaveLength(1);
    expect(other.children[0].label).toBe("Mystery Account");
    expect(other.row?.amountCentsByMonth["2026-01"]).toBe(4200);

    // Counted, not lost: Net Income includes both the recognized revenue row
    // and the unrecognized-section row.
    expect(netIncome.row?.amountCentsByMonth["2026-01"]).toBe(14200);
  });
});
