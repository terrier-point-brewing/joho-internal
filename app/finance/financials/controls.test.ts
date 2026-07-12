import { describe, it, expect } from "vitest";
import { qualityBucket, retainAncestors, buildFinancialsControls } from "./controls";
import { buildTree } from "./buildTree";
import { applyControls } from "@/lib/table/applyControls";
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

describe("qualityBucket", () => {
  it("returns unmapped when coaId is null, regardless of other fields", () => {
    const r = row({
      coaId: null, accountName: "Mystery", statementSection: "revenue",
      channel: "taproom", bblCoverage: "unknown",
      amountCentsByMonth: { "2026-01": 100 },
    });
    expect(qualityBucket(r)).toBe("unmapped");
  });

  it("returns uncategorized when channel is unknown but coaId is mapped", () => {
    const r = row({
      coaId: "rev-1", accountName: "Draft Sales", statementSection: "revenue",
      channel: "unknown", bblCoverage: "full",
      amountCentsByMonth: { "2026-01": 100 },
    });
    expect(qualityBucket(r)).toBe("uncategorized");
  });

  it("returns unknownVolume when coaId + channel are set but bblCoverage isn't full", () => {
    const r = row({
      coaId: "rev-1", accountName: "Draft Sales", statementSection: "revenue",
      channel: "taproom", bblCoverage: "unknown",
      amountCentsByMonth: { "2026-01": 100 },
    });
    expect(qualityBucket(r)).toBe("unknownVolume");
  });

  it("returns ok (not uncategorized) for a non-beer row whose channel is the unknown default", () => {
    // Non-beer rows (rent, etc.) have no real channel dimension and
    // aggregateRows.ts hardcodes them to channel: "unknown" -- channel is
    // only meaningful for revenue/other-income rows, so an expense row is
    // never flagged just for lacking one.
    const r = row({
      coaId: "opex-1", accountName: "Rent", statementSection: "expenses",
      channel: "unknown", bblCoverage: "full",
      amountCentsByMonth: { "2026-01": -2000 },
    });
    expect(qualityBucket(r)).toBe("ok");
  });

  it("returns uncategorized for a revenue row with an unknown channel", () => {
    const r = row({
      coaId: "rev-3", accountName: "Mystery Sales", statementSection: "revenue",
      channel: "unknown", bblCoverage: "full",
      amountCentsByMonth: { "2026-01": 250 },
    });
    expect(qualityBucket(r)).toBe("uncategorized");
  });

  it("returns ok when mapped, categorized, and fully volume-covered", () => {
    const clean = row({
      coaId: "rev-2", accountName: "Can Sales", statementSection: "revenue",
      channel: "taproom", bblCoverage: "full",
      amountCentsByMonth: { "2026-01": 500 },
    });
    expect(qualityBucket(clean)).toBe("ok");
  });

  it("ignores mappingSource entirely (invoice provenance is unreliable)", () => {
    const unmappedButManual = row({
      coaId: null, accountName: "X", statementSection: "revenue",
      channel: "taproom", bblCoverage: "full", mappingSource: "manual",
      amountCentsByMonth: { "2026-01": 1 },
    });
    expect(qualityBucket(unmappedButManual)).toBe("unmapped");

    const mappedButUnmappedSource = row({
      coaId: "rev-1", accountName: "Y", statementSection: "revenue",
      channel: "taproom", bblCoverage: "full", mappingSource: "unmapped",
      amountCentsByMonth: { "2026-01": 1 },
    });
    expect(qualityBucket(mappedButUnmappedSource)).toBe("ok");
  });
});

describe("retainAncestors", () => {
  const parent = row({
    coaId: "parent-1", accountName: "Beer Sales", statementSection: "revenue",
    channel: "taproom", amountCentsByMonth: { "2026-01": 1000 },
  });
  const child = row({
    coaId: "child-1", parentId: "parent-1", accountName: "Draft Sales", statementSection: "revenue",
    channel: "taproom", amountCentsByMonth: { "2026-01": 400 },
  });
  const grandchild = row({
    coaId: "grandchild-1", parentId: "child-1", accountName: "IPA Draft", statementSection: "revenue",
    channel: "taproom", amountCentsByMonth: { "2026-01": 100 },
  });
  const unrelated = row({
    coaId: "opex-1", accountName: "Rent", statementSection: "expenses",
    amountCentsByMonth: { "2026-01": -500 },
  });
  const allRows = [parent, child, grandchild, unrelated];

  it("adds back a matched leaf's whole ancestor chain", () => {
    const survivors = [grandchild];
    const out = retainAncestors(survivors, allRows);
    expect(out).toContain(grandchild);
    expect(out).toContain(child);
    expect(out).toContain(parent);
    expect(out).not.toContain(unrelated);
  });

  it("keeps survivors at the front in their given (e.g. sorted) order", () => {
    const survivors = [grandchild, child];
    const out = retainAncestors(survivors, allRows);
    expect(out.slice(0, 2)).toEqual([grandchild, child]);
  });

  it("does not duplicate a row that is both a survivor and someone's ancestor", () => {
    const survivors = [child, grandchild];
    const out = retainAncestors(survivors, allRows);
    expect(out.filter((r) => r === child)).toHaveLength(1);
  });

  it("is a no-op when survivors have no missing ancestors", () => {
    const survivors = [parent, child, grandchild];
    const out = retainAncestors(survivors, allRows);
    expect(out).toEqual(survivors);
  });

  it("returns [] for [] survivors", () => {
    expect(retainAncestors([], allRows)).toEqual([]);
  });

  it("pulls in every channel-slice row for a retained ancestor's account, not just one", () => {
    const parentDistribution = row({
      coaId: "parent-1", accountName: "Beer Sales", statementSection: "revenue",
      channel: "distribution", amountCentsByMonth: { "2026-01": 300 },
    });
    const rows = [...allRows, parentDistribution];
    const out = retainAncestors([child], rows);
    expect(out).toContain(parent);
    expect(out).toContain(parentDistribution);
  });
});

describe("retainAncestors + buildTree integration (sort reorders leaves within a section)", () => {
  it("keeps a search-matched child rendered under its (non-matching) parent", () => {
    const parent = row({
      coaId: "parent-1", accountName: "Beer Sales", statementSection: "revenue",
      channel: "taproom", amountCentsByMonth: { "2026-01": 1000 },
    });
    const draft = row({
      coaId: "draft-1", parentId: "parent-1", accountName: "Draft Sales", statementSection: "revenue",
      channel: "taproom", amountCentsByMonth: { "2026-01": 400 },
    });
    const cans = row({
      coaId: "cans-1", parentId: "parent-1", accountName: "Can Sales", statementSection: "revenue",
      channel: "taproom", amountCentsByMonth: { "2026-01": 600 },
    });
    const allRows = [parent, draft, cans];

    // Search for "draft" -- only the child matches.
    const config = buildFinancialsControls(["2026-01"]);
    const survivors = applyControls(allRows, config, { search: { q: "draft" }, filters: {}, sort: null });
    expect(survivors).toEqual([draft]);

    const treeRows = retainAncestors(survivors, allRows);
    const tree = buildTree(treeRows, "pl");
    const revenueSection = tree.find((n) => n.label === "Revenue")!;
    expect(revenueSection.children.map((n) => n.label)).toEqual(["Beer Sales"]);
    expect(revenueSection.children[0].children.map((n) => n.label)).toEqual(["Draft Sales"]);
  });

  it("sorting the flat rows by amount reorders sibling leaves within their section", () => {
    const low = row({
      coaId: "a-1", accountName: "A Account", statementSection: "revenue",
      channel: "taproom", amountCentsByMonth: { "2026-01": 100 },
    });
    const high = row({
      coaId: "b-1", accountName: "B Account", statementSection: "revenue",
      channel: "taproom", amountCentsByMonth: { "2026-01": 900 },
    });
    const allRows = [low, high];
    const config = buildFinancialsControls(["2026-01"]);

    const ascending = applyControls(allRows, config, { search: {}, filters: {}, sort: { key: "total", dir: "asc" } });
    const ascTree = buildTree(retainAncestors(ascending, allRows), "pl");
    const ascRevenue = ascTree.find((n) => n.label === "Revenue")!;
    expect(ascRevenue.children.map((n) => n.label)).toEqual(["A Account", "B Account"]);

    const descending = applyControls(allRows, config, { search: {}, filters: {}, sort: { key: "total", dir: "desc" } });
    const descTree = buildTree(retainAncestors(descending, allRows), "pl");
    const descRevenue = descTree.find((n) => n.label === "Revenue")!;
    expect(descRevenue.children.map((n) => n.label)).toEqual(["B Account", "A Account"]);
  });
});
