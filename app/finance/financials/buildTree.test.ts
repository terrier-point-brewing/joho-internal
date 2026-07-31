import { describe, it, expect } from "vitest";
import { buildTree } from "./buildTree";
import { normalizeSignedCents } from "@/lib/finance/financials/normalizeSign";
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

// Reproduces the real-world CoA shape: grouping accounts like "Taproom
// Revenue" or "Taproom Liquor Sales" exist in chart_of_accounts purely to
// organize their children -- every actual transaction posts to a deeper leaf
// (e.g. "Taproom Wine Sales"). Those grouping accounts never appear in
// FinancialsRow[] (no postings of their own), so buildTree must consult the
// CoaAccountRef[] reference table to still nest a leaf under them instead of
// flattening every leaf into a false section-root.
describe("buildTree — pl nesting through ancestor accounts with no direct postings", () => {
  const coaAccounts = [
    { id: "root", parentId: null, accountName: "BREWERY REVENUE", accountNumber: "4000", statementSection: "revenue" },
    { id: "taproom-rev", parentId: "root", accountName: "BREWERY REVENUE:Taproom Revenue", accountNumber: "4100", statementSection: "revenue" },
    { id: "taproom-liquor", parentId: "taproom-rev", accountName: "BREWERY REVENUE:Taproom Revenue:Taproom Liquor Sales", accountNumber: "4110", statementSection: "revenue" },
    { id: "wine", parentId: "taproom-liquor", accountName: "BREWERY REVENUE:Taproom Revenue:Taproom Liquor Sales:Taproom Wine Sales", accountNumber: "4111", statementSection: "revenue" },
    { id: "keg", parentId: "taproom-rev", accountName: "BREWERY REVENUE:Taproom Revenue:Taproom Keg Sales", accountNumber: "4120", statementSection: "revenue" },
  ];

  const rows: FinancialsRow[] = [
    row({
      coaId: "wine", parentId: "taproom-liquor",
      accountName: "BREWERY REVENUE:Taproom Revenue:Taproom Liquor Sales:Taproom Wine Sales",
      statementSection: "revenue", amountCentsByMonth: { "2026-01": 1000 },
    }),
    row({
      coaId: "keg", parentId: "taproom-rev",
      accountName: "BREWERY REVENUE:Taproom Revenue:Taproom Keg Sales",
      statementSection: "revenue", amountCentsByMonth: { "2026-01": 400 },
    }),
  ];

  const tree = buildTree(rows, "pl", coaAccounts);
  const revenue = tree.find((n) => n.label === "Revenue")!;

  it("synthesizes zero-posting ancestor nodes so leaves nest under their true parent, not as flat roots", () => {
    // Only ONE root: "BREWERY REVENUE" (root's own parent_id is null) --
    // both leaves collapse under it instead of appearing as 2 section roots.
    expect(revenue.children).toHaveLength(1);
    const brewery = revenue.children[0];
    expect(brewery.label).toBe("BREWERY REVENUE");
    expect(brewery.depth).toBe(1);

    expect(brewery.children).toHaveLength(1);
    const taproomRev = brewery.children[0];
    expect(taproomRev.label).toBe("Taproom Revenue"); // parent prefix "BREWERY REVENUE:" stripped
    expect(taproomRev.depth).toBe(2);

    // Two children at this level: the "Taproom Liquor Sales" grouping node, and the "Taproom Keg Sales" leaf.
    expect(taproomRev.children.map((c) => c.label).sort()).toEqual(["Taproom Keg Sales", "Taproom Liquor Sales"]);
    const liquor = taproomRev.children.find((c) => c.label === "Taproom Liquor Sales")!;
    expect(liquor.depth).toBe(3);

    expect(liquor.children).toHaveLength(1);
    const wine = liquor.children[0];
    expect(wine.label).toBe("Taproom Wine Sales"); // "Taproom Liquor Sales:" prefix stripped, relative to ITS immediate parent
    expect(wine.depth).toBe(4);
  });

  it("rolls zero-posting ancestor nodes' totals up from their descendants (no amount of their own)", () => {
    const brewery = revenue.children[0];
    const taproomRev = brewery.children[0];
    const liquor = taproomRev.children.find((c) => c.label === "Taproom Liquor Sales")!;

    expect(liquor.row?.amountCentsByMonth).toEqual({ "2026-01": 1000 }); // == wine's own amount, liquor itself has none
    expect(taproomRev.row?.amountCentsByMonth).toEqual({ "2026-01": 1400 }); // wine + keg
    expect(brewery.row?.amountCentsByMonth).toEqual({ "2026-01": 1400 });
    expect(revenue.row?.amountCentsByMonth).toEqual({ "2026-01": 1400 }); // no double count at the section level
  });

  it("falls back to the leaf's own row data (not the CoA table) when no coaAccounts are supplied", () => {
    // Without the CoaAccountRef[] table, only rows' own parentId chains are
    // usable -- "taproom-rev"/"taproom-liquor" have no rows of their own, so
    // they can't be described/synthesized, and both leaves become roots.
    const noRefTree = buildTree(rows, "pl");
    const noRefRevenue = noRefTree.find((n) => n.label === "Revenue")!;
    expect(noRefRevenue.children).toHaveLength(2);
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

  it("does not shorten a root account's own label when it doesn't overlap the section title", () => {
    const rows: FinancialsRow[] = [
      row({ coaId: "root-1", accountName: "Utilities:Electric", statementSection: "expenses", amountCentsByMonth: { "2026-01": -100 } }),
    ];
    const tree = buildTree(rows, "pl");
    const opEx = tree.find((n) => n.label === "Operating Expenses")!;
    expect(opEx.children[0].label).toBe("Utilities:Electric");
  });
});

// Real CoA shape (verified live): a section's top/root account is often the
// literal "type root" QuickBooks imported alongside the type itself -- e.g.
// real root account "COST OF GOODS SOLD (COGS)" sits directly under the
// (hardcoded) "Cost of Goods Sold" section label. An earlier attempt shortened
// a root account against the section's own title (same rule used for real
// parent/child pairs) -- but that caused a regression: an EXACT-match root
// like "OPERATING EXPENSES" under "Operating Expenses" correctly fell back to
// its full name (nothing left to strip), while a suffixed one like this COGS
// root got reduced to the bare fragment "(COGS)". Root accounts now always
// show their full name; the section/account visual distinction is handled by
// FinancialsTable's static (non-dropdown) SectionBlock styling instead.
describe("buildTree — pl root account name vs. its section title", () => {
  it("shows a root account's full name even when it repeats the section label as a prefix", () => {
    const rows: FinancialsRow[] = [
      row({
        coaId: "cogs-root", accountName: "COST OF GOODS SOLD (COGS)", statementSection: "cogs",
        amountCentsByMonth: { "2026-01": -100 },
      }),
    ];
    const tree = buildTree(rows, "pl");
    const cogs = tree.find((n) => n.label === "Cost of Goods Sold")!;
    expect(cogs.children).toHaveLength(1);
    expect(cogs.children[0].label).toBe("COST OF GOODS SOLD (COGS)");
  });

  it("leaves a root account's name alone when it doesn't share the section's title as a prefix", () => {
    const rows: FinancialsRow[] = [
      row({ coaId: "brewery-rev", accountName: "BREWERY REVENUE", statementSection: "revenue", amountCentsByMonth: { "2026-01": 100 } }),
      row({ coaId: "returns", accountName: "Sales Returns & Refunds", statementSection: "revenue", amountCentsByMonth: { "2026-01": -10 } }),
    ];
    const tree = buildTree(rows, "pl");
    const revenue = tree.find((n) => n.label === "Revenue")!;
    expect(revenue.children.map((c) => c.label).sort()).toEqual(["BREWERY REVENUE", "Sales Returns & Refunds"]);
    // Both real CoA roots, same depth -- neither a false child of the other.
    expect(revenue.children.every((c) => c.depth === 1)).toBe(true);
  });
});

describe("buildTree — pl orders siblings by GL account number", () => {
  const coaAccounts = [
    { id: "returns", parentId: null, accountName: "Sales Returns & Refunds", accountNumber: "4999", statementSection: "revenue" },
    { id: "brewery", parentId: null, accountName: "BREWERY REVENUE", accountNumber: "4000", statementSection: "revenue" },
  ];

  it("sorts root accounts ascending by GL number regardless of insertion order", () => {
    const rows: FinancialsRow[] = [
      row({ coaId: "returns", accountName: "Sales Returns & Refunds", statementSection: "revenue", amountCentsByMonth: { "2026-01": -10 } }),
      row({ coaId: "brewery", accountName: "BREWERY REVENUE", statementSection: "revenue", amountCentsByMonth: { "2026-01": 100 } }),
    ];
    const tree = buildTree(rows, "pl", coaAccounts);
    const revenue = tree.find((n) => n.label === "Revenue")!;
    expect(revenue.children.map((c) => c.label)).toEqual(["BREWERY REVENUE", "Sales Returns & Refunds"]);
  });

  it("sorts an account with no GL number (e.g. a synthesized top-line adjustment) after every numbered account", () => {
    const rows: FinancialsRow[] = [
      row({ coaId: null, accountName: "Manual Net-Sales Adjustment", statementSection: "revenue", amountCentsByMonth: { "2026-01": 5 } }),
      row({ coaId: "returns", accountName: "Sales Returns & Refunds", statementSection: "revenue", amountCentsByMonth: { "2026-01": -10 } }),
      row({ coaId: "brewery", accountName: "BREWERY REVENUE", statementSection: "revenue", amountCentsByMonth: { "2026-01": 100 } }),
    ];
    const tree = buildTree(rows, "pl", coaAccounts);
    const revenue = tree.find((n) => n.label === "Revenue")!;
    expect(revenue.children.map((c) => c.label)).toEqual(["BREWERY REVENUE", "Sales Returns & Refunds", "Manual Net-Sales Adjustment"]);
  });

  it("sorts nested children by GL number too, independent of their parent's ordering", () => {
    const nestedCoa = [
      { id: "parent", parentId: null, accountName: "Parent", accountNumber: "5000", statementSection: "cogs" },
      { id: "child-b", parentId: "parent", accountName: "Child B", accountNumber: "5200", statementSection: "cogs" },
      { id: "child-a", parentId: "parent", accountName: "Child A", accountNumber: "5100", statementSection: "cogs" },
    ];
    const rows: FinancialsRow[] = [
      row({ coaId: "child-b", parentId: "parent", accountName: "Child B", statementSection: "cogs", amountCentsByMonth: { "2026-01": -20 } }),
      row({ coaId: "child-a", parentId: "parent", accountName: "Child A", statementSection: "cogs", amountCentsByMonth: { "2026-01": -10 } }),
    ];
    const tree = buildTree(rows, "pl", nestedCoa);
    const cogs = tree.find((n) => n.label === "Cost of Goods Sold")!;
    const parent = cogs.children[0];
    expect(parent.children.map((c) => c.label)).toEqual(["Child A", "Child B"]);
  });
});

// Rows are fixtured in the INTERNAL storage convention (normalizeSign.ts:
// assets positive, liabilities/equity negative) -- exactly what a provider's
// compute() or a P&L-derived row would store. buildTree's presentation flip
// (spec §4.5) negates the five credit-side sections AFTER every sum, so the
// assertions below check the DISPLAYED (post-flip, liabilities/equity
// positive) values, not the internal ones.
describe("buildTree — balance_sheet", () => {
  const rows: FinancialsRow[] = [
    row({ coaId: "bank-1", accountName: "Checking", statementSection: "bank", amountCentsByMonth: { "2026-01": 100000 } }),
    row({ coaId: "ar-1", accountName: "AR", statementSection: "ar", amountCentsByMonth: { "2026-01": 20000 } }),
    row({ coaId: "fixed-1", accountName: "Equipment", statementSection: "fixed_assets", amountCentsByMonth: { "2026-01": 50000 } }),
    row({ coaId: "ap-1", accountName: "AP", statementSection: "ap", amountCentsByMonth: { "2026-01": -15000 } }),
    row({ coaId: "cc-1", accountName: "Visa", statementSection: "credit_card", amountCentsByMonth: { "2026-01": -5000 } }),
    row({ coaId: "ocl-1", accountName: "Accrued Liabilities", statementSection: "other_current_liabilities", amountCentsByMonth: { "2026-01": -3000 } }),
    row({ coaId: "ltl-1", accountName: "Loan Payable", statementSection: "long_term_liabilities", amountCentsByMonth: { "2026-01": -7000 } }),
    row({ coaId: "eq-1", accountName: "Owner Equity", statementSection: "equity", amountCentsByMonth: { "2026-01": -140000 } }),
  ];

  const tree = buildTree(rows, "balance_sheet");

  it("builds the 17 balance-sheet section/subtotal nodes in order (incl. the M1 'Other' catch-all + Balancing Difference)", () => {
    expect(tree.map((n) => n.label)).toEqual([
      "Bank & Cash", "Accounts Receivable", "Other Current Assets", "Total Current Assets",
      "Fixed Assets", "Other Assets", "Total Assets",
      "Accounts Payable", "Credit Cards", "Other Current Liabilities", "Total Current Liabilities",
      "Long-Term Liabilities", "Total Liabilities",
      "Equity", "Other", "Total Liabilities + Equity", "Balancing Difference",
    ]);
  });

  it("rolls current-asset sections into Total Current Assets, then adds Fixed Assets into Total Assets (assets untouched by the flip)", () => {
    const totalCurrentAssets = tree[3];
    const totalAssets = tree[6];
    expect(totalCurrentAssets.row?.amountCentsByMonth["2026-01"]).toBe(120000);
    expect(totalAssets.row?.amountCentsByMonth["2026-01"]).toBe(170000);
  });

  it("negates exactly the five credit-side sections so each renders positive", () => {
    const [ap, creditCard, otherCurrentLiab] = [tree[7], tree[8], tree[9]];
    const [longTermLiab, equity] = [tree[11], tree[13]];
    expect(ap.row?.amountCentsByMonth["2026-01"]).toBe(15000);
    expect(creditCard.row?.amountCentsByMonth["2026-01"]).toBe(5000);
    expect(otherCurrentLiab.row?.amountCentsByMonth["2026-01"]).toBe(3000);
    expect(longTermLiab.row?.amountCentsByMonth["2026-01"]).toBe(7000);
    expect(equity.row?.amountCentsByMonth["2026-01"]).toBe(140000);
  });

  it("rolls the (now-positive) liability sections + equity into Total Liabilities + Equity", () => {
    const totalCurrentLiab = tree[10];
    const totalLiab = tree[12];
    const totalLE = tree[15];
    expect(totalCurrentLiab.row?.amountCentsByMonth["2026-01"]).toBe(23000); // 15000 + 5000 + 3000
    expect(totalLiab.row?.amountCentsByMonth["2026-01"]).toBe(30000); // + 7000 long-term
    expect(totalLE.row?.amountCentsByMonth["2026-01"]).toBe(170000); // + 140000 equity
  });

  it("computes the Balancing Difference as Total Assets − (Total Liabilities + Equity), post-flip, zero when the books balance", () => {
    const totalAssets = tree[6];
    const totalLE = tree[15];
    const diff = tree[16];
    expect(diff.label).toBe("Balancing Difference");
    expect(diff.row?.amountCentsByMonth["2026-01"]).toBe(
      (totalAssets.row?.amountCentsByMonth["2026-01"] ?? 0) - (totalLE.row?.amountCentsByMonth["2026-01"] ?? 0),
    );
    expect(diff.row?.amountCentsByMonth["2026-01"]).toBe(0);
  });

  it("Balancing Difference is well-defined and non-zero when an entire side is absent", () => {
    const assetsOnly: FinancialsRow[] = [
      row({ coaId: "bank-1", accountName: "Checking", statementSection: "bank", amountCentsByMonth: { "2026-01": 100000 } }),
    ];
    const t = buildTree(assetsOnly, "balance_sheet");
    const totalAssets = t.find((n) => n.label === "Total Assets")!;
    const totalLE = t.find((n) => n.label === "Total Liabilities + Equity")!;
    const diff = t.find((n) => n.label === "Balancing Difference")!;
    expect(totalAssets.row?.amountCentsByMonth["2026-01"]).toBe(100000);
    expect(totalLE.row?.amountCentsByMonth["2026-01"]).toBe(0);
    expect(diff.row?.amountCentsByMonth["2026-01"]).toBe(100000);
  });
});
// The balance-sheet presentation flip is covered structurally below (that it
// negates exactly the five credit-side sections and leaves assets and every P&L
// tree alone). It is deliberately NOT covered by an "equivalence gate" here.
//
// A previous version of this file claimed to be one: it froze seven real
// production magnitudes, ran each through normalizeSignedCents -- the very
// function under test -- and asserted the flipped value was its negation. That
// is true by construction for ANY flip function. It never ran a provider, never
// wrote or read a snapshot, and never compared against pre-branch output, so it
// constrained nothing; six real defects passed it. Two of its seven frozen
// numbers were also simply wrong. Do not reintroduce a gate shaped like that.
//
// The equivalence work was done by a one-shot gate -- a capture of what the
// pre-snapshot pipeline produced from production, diffed against the provider
// path -- which lived in lib/finance/balances/__fixtures__/goldenBalanceSheet.ts
// and scripts/balance-sheet-parity.ts. Both were removed after the migration
// applied and parity passed: the pipeline they photographed no longer exists,
// and a frozen capture drifts as historical data is edited, so keeping them
// would have meant a gate that silently goes wrong. Recoverable from git
// history at commit 5205004 if a similar migration ever needs the same
// treatment.

describe("buildTree — balance_sheet with an Other Assets row", () => {
  const rows: FinancialsRow[] = [
    row({ coaId: "bank-1", accountName: "Chase", statementSection: "bank", amountCentsByMonth: { "2026-01": 100000 } }),
    row({ coaId: "dep-1", accountName: "Security Deposits Paid", statementSection: "other_assets", amountCentsByMonth: { "2026-01": 25000 } }),
  ];

  const tree = buildTree(rows, "balance_sheet");
  const byLabel = (label: string) => tree.find((n) => n.label === label);

  it("excludes Other Assets from Total Current Assets", () => {
    expect(byLabel("Total Current Assets")?.row?.amountCentsByMonth["2026-01"]).toBe(100000);
  });

  it("includes Other Assets in Total Assets", () => {
    expect(byLabel("Other Assets")?.row?.amountCentsByMonth["2026-01"]).toBe(25000);
    expect(byLabel("Total Assets")?.row?.amountCentsByMonth["2026-01"]).toBe(125000);
  });

  it("does not fall into the 'Other' unrecognised-section catch-all", () => {
    expect(byLabel("Other")?.row?.amountCentsByMonth["2026-01"] ?? 0).toBe(0);
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
    expect(buildTree([], "balance_sheet")).toHaveLength(17);
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

describe("buildTree — pl seeds a real root account with zero postings as a $0 line", () => {
  it("renders a currently-unused real CoA account (e.g. Interest Earned) instead of the section reading as empty", () => {
    const coaAccounts = [
      { id: "interest", parentId: null, accountName: "Interest Earned", accountNumber: "7010", statementSection: "other_income" },
    ];
    const tree = buildTree([], "pl", coaAccounts);
    const otherIncome = tree.find((n) => n.label === "Other Income")!;

    expect(otherIncome.children).toHaveLength(1);
    expect(otherIncome.children[0].label).toBe("Interest Earned");
    expect(otherIncome.children[0].row?.amountCentsByMonth).toEqual({}); // zero-postings node -- no months since rows was []
  });

  it("does not duplicate a real root account that already has postings", () => {
    const coaAccounts = [
      { id: "interest", parentId: null, accountName: "Interest Earned", accountNumber: "7010", statementSection: "other_income" },
    ];
    const rows: FinancialsRow[] = [
      row({ coaId: "interest", accountName: "Interest Earned", statementSection: "other_income", amountCentsByMonth: { "2026-01": 500 } }),
    ];
    const tree = buildTree(rows, "pl", coaAccounts);
    const otherIncome = tree.find((n) => n.label === "Other Income")!;
    expect(otherIncome.children).toHaveLength(1);
    expect(otherIncome.children[0].row?.amountCentsByMonth).toEqual({ "2026-01": 500 });
  });
});

describe("buildTree — excludes cross-statement and unmapped rows from Net Income / Total (no double-counting)", () => {
  it("excludes a row mapped to a genuine Balance Sheet account from the P&L's Net Income", () => {
    const rows: FinancialsRow[] = [
      row({ coaId: "rev-1", accountName: "Draft Sales", statementSection: "revenue", amountCentsByMonth: { "2026-01": 10000 } }),
      // A capex purchase miscoded to a real Fixed Assets account -- shows up in expenses' source table, but its statementSection is a Balance Sheet section, not a P&L one.
      row({ coaId: "equip-1", accountName: "Brewery Machinery & Equipment", statementSection: "fixed_assets", amountCentsByMonth: { "2026-01": -50000 } }),
    ];

    const plTree = buildTree(rows, "pl");
    const other = plTree.find((n) => n.label === "Other")!;
    const netIncome = plTree.find((n) => n.label === "Net Income")!;
    expect(other.children).toHaveLength(0); // not surfaced under P&L's "Other" at all
    expect(netIncome.row?.amountCentsByMonth["2026-01"]).toBe(10000); // only the real revenue row -- the BS posting never counted

    // It DOES still render correctly under its own real Balance Sheet section.
    const bsTree = buildTree(rows, "balance_sheet");
    const fixedAssets = bsTree.find((n) => n.label === "Fixed Assets")!;
    expect(fixedAssets.children).toHaveLength(1);
    expect(fixedAssets.children[0].label).toBe("Brewery Machinery & Equipment");
  });

  it("excludes a genuinely unmapped row (no coaId at all) from both P&L Net Income and Balance Sheet totals", () => {
    const rows: FinancialsRow[] = [
      row({ coaId: "rev-1", accountName: "Draft Sales", statementSection: "revenue", amountCentsByMonth: { "2026-01": 10000 } }),
      row({ coaId: null, accountName: "Unclassified", statementSection: "unmapped", amountCentsByMonth: { "2026-01": 99999 } }),
    ];

    const plTree = buildTree(rows, "pl");
    const other = plTree.find((n) => n.label === "Other")!;
    const netIncome = plTree.find((n) => n.label === "Net Income")!;
    expect(other.children).toHaveLength(0);
    expect(netIncome.row?.amountCentsByMonth["2026-01"]).toBe(10000);

    const bsTree = buildTree(rows, "balance_sheet");
    const bsOther = bsTree.find((n) => n.label === "Other")!;
    expect(bsOther.children).toHaveLength(0);
  });
});

// The 4100 case. A manual net-sales adjustment (manual_entries) posts to a
// REAL account's coaId, so it arrives in that account's own row bucket. Two
// distinct bugs fell out of that for 4100 BREWERY REVENUE:Taproom Revenue,
// whose every real posting lands on a 41x0 leaf so the adjustment is its ONLY
// own row: (1) the adjustment's null parentId promoted 4100 to a section root,
// rendering it beside its own parent 4000 instead of under it; (2) the
// adjustment silently merged into 4100's total, so 4100 didn't equal the sum
// of the sub-accounts shown beneath it and nothing on screen said why.
describe("buildTree — manual adjustment posted to a grouping account (4100)", () => {
  const coaAccounts = [
    { id: "coa-4000", parentId: null, accountName: "BREWERY REVENUE", accountNumber: "4000", statementSection: "revenue" },
    { id: "coa-4100", parentId: "coa-4000", accountName: "BREWERY REVENUE:Taproom Revenue", accountNumber: "4100", statementSection: "revenue" },
    { id: "coa-4110", parentId: "coa-4100", accountName: "BREWERY REVENUE:Taproom Revenue:Taproom Beer Sales", accountNumber: "4110", statementSection: "revenue" },
    { id: "coa-4120", parentId: "coa-4100", accountName: "BREWERY REVENUE:Taproom Revenue:Taproom Liquor Sales", accountNumber: "4120", statementSection: "revenue" },
  ];

  // parentId "coa-4000" is what injectManualNetSales now supplies (it reads the
  // real account's parent); the null-parentId case is covered separately below.
  const adjustment = row({
    coaId: "coa-4100", parentId: "coa-4000",
    accountName: "BREWERY REVENUE:Taproom Revenue (Manual Adjustment)",
    statementSection: "revenue", channel: "taproom",
    amountCentsByMonth: { "2026-01": 25000 },
    sourceRef: { table: "manual_entries", ids: ["m-1"] },
  });

  const rows: FinancialsRow[] = [
    row({
      coaId: "coa-4110", parentId: "coa-4100", accountName: "BREWERY REVENUE:Taproom Revenue:Taproom Beer Sales",
      statementSection: "revenue", channel: "taproom", amountCentsByMonth: { "2026-01": 100000 },
    }),
    row({
      coaId: "coa-4120", parentId: "coa-4100", accountName: "BREWERY REVENUE:Taproom Revenue:Taproom Liquor Sales",
      statementSection: "revenue", channel: "taproom", amountCentsByMonth: { "2026-01": 40000 },
    }),
    adjustment,
  ];

  const revenue = buildTree(rows, "pl", coaAccounts).find((n) => n.label === "Revenue")!;

  it("nests 4100 under 4000 instead of rendering it as a second section root", () => {
    expect(revenue.children.map((c) => c.label)).toEqual(["BREWERY REVENUE"]);
    const brewery = revenue.children[0];
    expect(brewery.children.map((c) => c.label)).toEqual(["Taproom Revenue"]);
    // ...and 4100 is labelled as the account it is, not as the adjustment row
    // that happens to be its only own posting.
    expect(brewery.children[0].label).not.toContain("Manual Adjustment");
  });

  it("breaks the adjustment out as its own flagged line, last, beneath 4100's real sub-accounts", () => {
    const taproomRev = revenue.children[0].children[0];
    expect(taproomRev.children.map((c) => c.label)).toEqual([
      "Taproom Beer Sales", "Taproom Liquor Sales", "Manual Adjustment",
    ]);

    const adj = taproomRev.children[2];
    expect(adj.isAdjustment).toBe(true);
    expect(adj.depth).toBe(taproomRev.depth + 1);
    expect(adj.row?.amountCentsByMonth).toEqual({ "2026-01": 25000 });
    // Only the adjustment is flagged -- a real sub-account never is.
    expect(taproomRev.children.slice(0, 2).every((c) => !c.isAdjustment)).toBe(true);
  });

  it("keeps 4100's total inclusive of the adjustment, and equal to its visible children", () => {
    const brewery = revenue.children[0];
    const taproomRev = brewery.children[0];

    // 100000 + 40000 + 25000 -- breaking the adjustment out is a presentation
    // split, so the total is what it always was...
    expect(taproomRev.row?.amountCentsByMonth).toEqual({ "2026-01": 165000 });
    // ...and now visibly reconciles against the lines rendered beneath it.
    const childSum = taproomRev.children.reduce((s, c) => s + (c.row?.amountCentsByMonth["2026-01"] ?? 0), 0);
    expect(childSum).toBe(165000);

    // No double count anywhere up the chain.
    expect(brewery.row?.amountCentsByMonth).toEqual({ "2026-01": 165000 });
    expect(revenue.row?.amountCentsByMonth).toEqual({ "2026-01": 165000 });
  });

  it("still nests 4100 under 4000 when the adjustment row itself carries no parentId", () => {
    // Belt-and-braces: buildTree consults the CoA reference table rather than
    // treating a synthesized row's null parentId as proof of a root account.
    const withNullParent = [rows[0], rows[1], { ...adjustment, parentId: null }];
    const rev = buildTree(withNullParent, "pl", coaAccounts).find((n) => n.label === "Revenue")!;
    expect(rev.children.map((c) => c.label)).toEqual(["BREWERY REVENUE"]);
    expect(rev.row?.amountCentsByMonth).toEqual({ "2026-01": 165000 });
  });

  it("does not emit a redundant child when the adjustment is an account's entire balance", () => {
    // 4100 with no sub-accounts and no postings of its own: the account row
    // already IS the adjustment, so a lone identical child would be noise.
    const rev = buildTree([adjustment], "pl", coaAccounts).find((n) => n.label === "Revenue")!;
    const taproomRev = rev.children[0].children[0];
    expect(taproomRev.children).toEqual([]);
    expect(taproomRev.row?.amountCentsByMonth).toEqual({ "2026-01": 25000 });
  });
});
