import { describe, expect, it } from "vitest";
import {
  approveAsset,
  archiveAsset,
  createAsset,
  listAssets,
  publicUrlFor,
  resolveAsset,
  type BrandAsset,
} from "./assets";

describe("publicUrlFor", () => {
  it("builds the public storage URL for a path", () => {
    const url = publicUrlFor("logo/x.svg");
    expect(url).toContain("/storage/v1/object/public/brand-assets/logo/x.svg");
  });
});

// A minimal fake Supabase-like client covering the query shapes assets.ts
// needs: from().select().eq()...limit()/order() (reads, chainable eq),
// from().insert().select().single() (createAsset's returned row), and
// from().update().eq() (approveAsset's archive + approve steps,
// archiveAsset). Configurable per test via `rows` so each function can be
// driven end-to-end against fake state. Mirrors canonWorkflow.test.ts's
// fakeClient, but enforces the brand_assets_one_approved invariant on the
// update-to-approved path (rather than insert, since approveAsset updates an
// existing row in place) — a wrong archive-after-approve ordering in
// approveAsset would hit this conflict and fail the approve test below.
interface Row extends BrandAsset {
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
              // Enforce the brand_assets_one_approved partial unique index:
              // an update that sets status='approved' fails if another row
              // with the same kind+variant is already approved.
              if (patch.status === "approved") {
                const target = rows.find((r) => (r as never)[column] === value);
                if (target) {
                  const conflict = rows.some(
                    (r) =>
                      r.id !== target.id &&
                      r.kind === target.kind &&
                      r.variant === target.variant &&
                      r.status === "approved",
                  );
                  if (conflict) {
                    return Promise.resolve({ error: new Error("duplicate approved row (one-approved index)") });
                  }
                }
              }
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
  id: overrides.id ?? "a1",
  kind: overrides.kind ?? "wordmark",
  variant: overrides.variant ?? "default",
  storage_path: overrides.storage_path ?? "wordmark/default.svg",
  format: overrides.format ?? "svg",
  file_meta: overrides.file_meta ?? {},
  status: overrides.status ?? "draft",
  ...overrides,
});

describe("resolveAsset", () => {
  it("returns the public URL for an approved row", async () => {
    const client = fakeClient([
      baseRow({ id: "a1", status: "approved", storage_path: "wordmark/approved.svg" }),
    ]);
    const url = await resolveAsset(client as never, { kind: "wordmark" });
    expect(url).toBe(publicUrlFor("wordmark/approved.svg"));
  });

  it("returns null when only a draft exists", async () => {
    const client = fakeClient([baseRow({ id: "a1", status: "draft" })]);
    const url = await resolveAsset(client as never, { kind: "wordmark" });
    expect(url).toBeNull();
  });
});

describe("listAssets", () => {
  it("lists all assets when no filter is given", async () => {
    const client = fakeClient([
      baseRow({ id: "a1", kind: "wordmark" }),
      baseRow({ id: "a2", kind: "logo" }),
    ]);
    const result = await listAssets(client as never);
    expect(result).toHaveLength(2);
  });

  it("filters by kind", async () => {
    const client = fakeClient([
      baseRow({ id: "a1", kind: "wordmark" }),
      baseRow({ id: "a2", kind: "logo" }),
    ]);
    const result = await listAssets(client as never, { kind: "logo" });
    expect(result.map((r) => r.id)).toEqual(["a2"]);
  });
});

describe("createAsset", () => {
  it("inserts a new row with status draft", async () => {
    const client = fakeClient([]);
    const created = await createAsset(client as never, {
      kind: "logo",
      variant: "default",
      storage_path: "logo/x.svg",
      format: "svg",
      file_meta: { bytes: 10 },
    });
    expect(created.status).toBe("draft");
    expect(created.id).toBeTruthy();
    expect(client.rows).toHaveLength(1);
  });
});

describe("approveAsset", () => {
  it("archives the prior approved row of the same kind+variant before approving the new one", async () => {
    const client = fakeClient([
      baseRow({ id: "a1", status: "approved", storage_path: "wordmark/old.svg" }),
      baseRow({ id: "a2", status: "draft", storage_path: "wordmark/new.svg" }),
    ]);
    await approveAsset(client as never, "a2");

    expect(client.rows.find((r) => r.id === "a1")?.status).toBe("archived");
    const approved = client.rows.find((r) => r.id === "a2");
    expect(approved?.status).toBe("approved");
    expect(approved?.approved_at).toBeTruthy();
  });

  it("approves a fresh kind+variant with no prior approved row", async () => {
    const client = fakeClient([baseRow({ id: "a1", kind: "logo", status: "draft" })]);
    await approveAsset(client as never, "a1");
    expect(client.rows.find((r) => r.id === "a1")?.status).toBe("approved");
  });
});

describe("archiveAsset", () => {
  it("sets status to archived", async () => {
    const client = fakeClient([baseRow({ id: "a1", status: "approved" })]);
    await archiveAsset(client as never, "a1");
    expect(client.rows.find((r) => r.id === "a1")?.status).toBe("archived");
  });
});
