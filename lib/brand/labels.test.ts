import { describe, expect, it } from "vitest";
import {
  approveLabel,
  archiveLabel,
  createLabel,
  getLabel,
  illustrationStatus,
  labelComponentStatus,
  listLabels,
  printOrderStatus,
  regulatoryStatus,
  resolveApprovedLabels,
  syncNamingCheck,
  updateLabel,
  type BrandLabel,
  type NamingCheck,
} from "./labels";

describe("syncNamingCheck", () => {
  it("preserves pass/note for a criterion that still exists", () => {
    const existing: NamingCheck = {
      results: [{ criterion: "Is it ownable?", pass: true, note: "yes, distinctive" }],
    };
    const result = syncNamingCheck(["Is it ownable?"], existing);
    expect(result.results).toEqual([{ criterion: "Is it ownable?", pass: true, note: "yes, distinctive" }]);
  });

  it("adds a new criterion as pass:false", () => {
    const existing: NamingCheck = { results: [] };
    const result = syncNamingCheck(["Is it pronounceable?"], existing);
    expect(result.results).toEqual([{ criterion: "Is it pronounceable?", pass: false }]);
  });

  it("drops a criterion that is no longer in the list", () => {
    const existing: NamingCheck = {
      results: [
        { criterion: "Is it ownable?", pass: true },
        { criterion: "Old removed criterion", pass: true },
      ],
    };
    const result = syncNamingCheck(["Is it ownable?"], existing);
    expect(result.results).toEqual([{ criterion: "Is it ownable?", pass: true }]);
  });

  it("output order matches the criteria argument order", () => {
    const existing: NamingCheck = {
      results: [
        { criterion: "B", pass: true },
        { criterion: "A", pass: false },
      ],
    };
    const result = syncNamingCheck(["A", "B", "C"], existing);
    expect(result.results.map((r) => r.criterion)).toEqual(["A", "B", "C"]);
    expect(result.results[0]).toEqual({ criterion: "A", pass: false });
    expect(result.results[1]).toEqual({ criterion: "B", pass: true });
    expect(result.results[2]).toEqual({ criterion: "C", pass: false });
  });
});

// A minimal fake Supabase-like client covering the query shapes labels.ts
// needs: from().select().eq()...limit()/order() (reads, chainable eq),
// from().insert().select().single() (createLabel's returned row), and
// from().update().eq() (updateLabel/approveLabel/archiveLabel). Mirrors
// assets.test.ts's fakeClient.
interface Row extends BrandLabel {
  created_at?: string;
  approved_at?: string | null;
}

function fakeClient(initialRows: Row[]) {
  const rows: Row[] = [...initialRows];
  let idCounter = rows.length;

  function applyFilters(filters: [string, string][]) {
    return rows.filter((r) => filters.every(([col, val]) => (r as never)[col] === val));
  }

  function chain(filters: [string, string][]) {
    return {
      eq(column: string, value: string) {
        return chain([...filters, [column, value]]);
      },
      order(_column: string, _opts?: { ascending?: boolean }) {
        return Promise.resolve({
          data: [...applyFilters(filters)].sort((a, b) => ((a.created_at ?? "") < (b.created_at ?? "") ? 1 : -1)),
          error: null,
        });
      },
      limit(n: number) {
        return Promise.resolve({ data: applyFilters(filters).slice(0, n), error: null });
      },
    };
  }

  return {
    rows,
    from() {
      return {
        select(_cols: string) {
          return chain([]);
        },
        insert(row: Partial<Row>) {
          return {
            select() {
              return {
                single() {
                  const newRow = { id: `id-${idCounter++}`, ...row } as Row;
                  rows.push(newRow);
                  return Promise.resolve({ data: newRow, error: null });
                },
              };
            },
          };
        },
        update(patch: Partial<Row>) {
          return {
            eq(column: string, value: string) {
              rows.forEach((r, i) => {
                if ((r as never)[column] === value) rows[i] = { ...r, ...patch };
              });
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  };
}

const baseRow = (overrides: Partial<Row>): Row => ({
  id: overrides.id ?? "l1",
  release_id: overrides.release_id ?? "r1",
  name: overrides.name ?? "Fortnight",
  subtitle: overrides.subtitle ?? null,
  description: overrides.description ?? null,
  motif_family: overrides.motif_family ?? null,
  status: overrides.status ?? "draft",
  tier2_palette: overrides.tier2_palette ?? { colors: [] },
  naming_check: overrides.naming_check ?? { results: [] },
  chop_glyph_asset_id: overrides.chop_glyph_asset_id ?? null,
  illustration: overrides.illustration ?? {},
  regulatory: overrides.regulatory ?? {},
  print_order: overrides.print_order ?? {},
  packaging_item_id: overrides.packaging_item_id ?? null,
  ...overrides,
});

describe("listLabels", () => {
  it("lists all labels when no filter is given", async () => {
    const client = fakeClient([baseRow({ id: "l1" }), baseRow({ id: "l2", status: "approved" })]);
    const result = await listLabels(client as never);
    expect(result).toHaveLength(2);
  });

  it("filters by status", async () => {
    const client = fakeClient([baseRow({ id: "l1" }), baseRow({ id: "l2", status: "approved" })]);
    const result = await listLabels(client as never, { status: "approved" });
    expect(result.map((r) => r.id)).toEqual(["l2"]);
  });
});

describe("getLabel", () => {
  it("returns the matching row", async () => {
    const client = fakeClient([baseRow({ id: "l1", name: "Fortnight" })]);
    const result = await getLabel(client as never, "l1");
    expect(result?.name).toBe("Fortnight");
  });

  it("returns null when not found", async () => {
    const client = fakeClient([]);
    const result = await getLabel(client as never, "missing");
    expect(result).toBeNull();
  });
});

describe("createLabel", () => {
  it("inserts a new row attached to its release, with empty stage blocks", async () => {
    const client = fakeClient([]);
    const created = await createLabel(client as never, { release_id: "r9", name: "New Label" });
    expect(created.status).toBe("draft");
    expect(created.release_id).toBe("r9");
    expect(created.tier2_palette).toEqual({ colors: [] });
    expect(created.naming_check).toEqual({ results: [] });
    expect(created.illustration).toEqual({});
    expect(created.regulatory).toEqual({});
    expect(created.print_order).toEqual({});
    expect(client.rows).toHaveLength(1);
  });
});

describe("stage status rollups", () => {
  it("illustrationStatus: not started → in progress on any field → done on uploaded art", () => {
    expect(illustrationStatus({})).toBe("not_started");
    expect(illustrationStatus(null)).toBe("not_started");
    expect(illustrationStatus({ artist_name: "Mei" })).toBe("in_progress");
    expect(illustrationStatus({ request_brief: "…" })).toBe("in_progress");
    expect(illustrationStatus({ asset_ids: ["a1"] })).toBe("done");
  });

  it("regulatoryStatus: done only on approval", () => {
    expect(regulatoryStatus({})).toBe("not_started");
    expect(regulatoryStatus({ submitted_at: "2026-08-01" })).toBe("in_progress");
    expect(regulatoryStatus({ approved: true })).toBe("done");
  });

  it("printOrderStatus: done once the order went out", () => {
    expect(printOrderStatus({})).toBe("not_started");
    expect(printOrderStatus({ printer: "CanCo", quantity: 5000 })).toBe("in_progress");
    expect(printOrderStatus({ ordered_at: "2026-08-01" })).toBe("done");
  });

  it("labelComponentStatus: aggregates the three stages", () => {
    expect(labelComponentStatus(baseRow({}))).toBe("not_started");
    expect(labelComponentStatus(baseRow({ illustration: { artist_name: "Mei" } }))).toBe("in_progress");
    // Design inputs alone count as started.
    expect(labelComponentStatus(baseRow({ chop_glyph_asset_id: "a1" }))).toBe("in_progress");
    expect(
      labelComponentStatus(
        baseRow({
          illustration: { asset_ids: ["a1"] },
          regulatory: { approved: true },
          print_order: { ordered_at: "2026-08-01" },
        }),
      ),
    ).toBe("done");
  });
});

describe("updateLabel", () => {
  it("applies the patch to the existing row", async () => {
    const client = fakeClient([baseRow({ id: "l1", name: "Old Name" })]);
    await updateLabel(client as never, "l1", { name: "New Name" });
    expect(client.rows.find((r) => r.id === "l1")?.name).toBe("New Name");
  });
});

describe("approveLabel", () => {
  it("sets status to approved and stamps approved_at", async () => {
    const client = fakeClient([baseRow({ id: "l1", status: "draft" })]);
    await approveLabel(client as never, "l1");
    const row = client.rows.find((r) => r.id === "l1");
    expect(row?.status).toBe("approved");
    expect(row?.approved_at).toBeTruthy();
  });

  it("allows multiple approved labels to coexist (no one-approved index)", async () => {
    const client = fakeClient([
      baseRow({ id: "l1", status: "approved" }),
      baseRow({ id: "l2", status: "draft" }),
    ]);
    await approveLabel(client as never, "l2");
    expect(client.rows.find((r) => r.id === "l1")?.status).toBe("approved");
    expect(client.rows.find((r) => r.id === "l2")?.status).toBe("approved");
  });
});

describe("archiveLabel", () => {
  it("sets status to archived", async () => {
    const client = fakeClient([baseRow({ id: "l1", status: "approved" })]);
    await archiveLabel(client as never, "l1");
    expect(client.rows.find((r) => r.id === "l1")?.status).toBe("archived");
  });
});

describe("resolveApprovedLabels", () => {
  it("returns only approved labels", async () => {
    const client = fakeClient([
      baseRow({ id: "l1", status: "approved" }),
      baseRow({ id: "l2", status: "draft" }),
      baseRow({ id: "l3", status: "archived" }),
    ]);
    const result = await resolveApprovedLabels(client as never);
    expect(result.map((r) => r.id)).toEqual(["l1"]);
  });
});
