import { describe, expect, it } from "vitest";
import {
  BRAND_ASSET_KINDS,
  approveAsset,
  archiveAsset,
  assetFileUrl,
  createAsset,
  listAssets,
  resolveAsset,
  updateAssetMeta,
  type BrandAsset,
} from "./assets";

describe("BRAND_ASSET_KINDS", () => {
  // This list mirrors the brand_assets.kind check constraint. If they drift, an
  // upload the API accepts is rejected by Postgres at insert time — so the
  // literal list is asserted here rather than derived, and updating it is a
  // deliberate two-file change alongside a migration.
  it("matches the kinds allowed by migration 20260903", () => {
    expect([...BRAND_ASSET_KINDS]).toEqual([
      "logo",
      "wordmark",
      "chop_glyph",
      "texture",
      "icon",
      "photo",
      "font",
      "example",
    ]);
  });
});

describe("assetFileUrl", () => {
  it("points at the session-gated proxy route, keyed by asset id", () => {
    expect(assetFileUrl("abc-123")).toBe("/api/brand/assets/abc-123/file");
  });

  it("is origin-relative and reads no Supabase env", () => {
    // The bucket is private (migration 20260903), so there is no public storage
    // URL to build. A permanent same-origin path also survives caching and works
    // as an @font-face src, which a signed URL would not.
    const url = assetFileUrl("abc-123");
    expect(url.startsWith("/")).toBe(true);
    expect(url).not.toContain("supabase");
    expect(url).not.toContain("/storage/v1/object/public");
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
  it("returns the proxied URL for an approved row", async () => {
    const client = fakeClient([
      baseRow({ id: "a1", status: "approved", storage_path: "wordmark/approved.svg" }),
    ]);
    const url = await resolveAsset(client as never, { kind: "wordmark" });
    expect(url).toBe(assetFileUrl("a1"));
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

describe("updateAssetMeta", () => {
  it("writes a title and alt text", async () => {
    const client = fakeClient([baseRow({ id: "a1" })]);
    await updateAssetMeta(client as never, "a1", {
      title: "Primary wordmark",
      alt_text: "The word Joho set in Marcellus",
    });

    const row = client.rows.find((r) => r.id === "a1") as unknown as Record<string, unknown>;
    expect(row.title).toBe("Primary wordmark");
    expect(row.alt_text).toBe("The word Joho set in Marcellus");
  });

  it("clears a field to null rather than an empty string", async () => {
    // A cleared title must fall back to the variant exactly as an unset one
    // does — "" would render as a blank label in every picker.
    const client = fakeClient([baseRow({ id: "a1" })]);
    await updateAssetMeta(client as never, "a1", { title: "   " });

    const row = client.rows.find((r) => r.id === "a1") as unknown as Record<string, unknown>;
    expect(row.title).toBeNull();
  });

  it("trims surrounding whitespace", async () => {
    const client = fakeClient([baseRow({ id: "a1" })]);
    await updateAssetMeta(client as never, "a1", { title: "  Chop  " });

    const row = client.rows.find((r) => r.id === "a1") as unknown as Record<string, unknown>;
    expect(row.title).toBe("Chop");
  });

  it("leaves a field alone when it is not supplied", async () => {
    const client = fakeClient([baseRow({ id: "a1", title: "Kept" } as never)]);
    await updateAssetMeta(client as never, "a1", { alt_text: "Only this changes" });

    const row = client.rows.find((r) => r.id === "a1") as unknown as Record<string, unknown>;
    expect(row.title).toBe("Kept");
    expect(row.alt_text).toBe("Only this changes");
  });

  it("does nothing at all when given no fields", async () => {
    const client = fakeClient([baseRow({ id: "a1" })]);
    const before = JSON.stringify(client.rows);
    await updateAssetMeta(client as never, "a1", {});
    expect(JSON.stringify(client.rows)).toBe(before);
  });
});
