import { describe, expect, it } from "vitest";
import {
  BRAND_ASSET_KINDS,
  approveAsset,
  archiveAsset,
  assetFileUrl,
  createAsset,
  deleteAsset,
  listAssets,
  normalizeVariant,
  resolveAsset,
  updateAssetMeta,
  type BrandAsset,
} from "./assets";

describe("BRAND_ASSET_KINDS", () => {
  // This list mirrors the brand_assets.kind check constraint. If they drift, an
  // upload the API accepts is rejected by Postgres at insert time — so the
  // literal list is asserted here rather than derived, and updating it is a
  // deliberate two-file change alongside a migration.
  // 20260907090000 restates the UNION of every kind any migration has declared,
  // after 20260811 was hand-applied out of order and clobbered `font`/`example`.
  it("matches the kinds allowed by migration 20260907090000", () => {
    expect([...BRAND_ASSET_KINDS]).toEqual([
      "logo",
      "wordmark",
      "chop_glyph",
      "texture",
      "icon",
      "photo",
      "font",
      "example",
      "label_art",
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

// `otherTables` holds the non-asset brand tables deleteAsset's reference sweep
// reads. Every one of them is scanned whole, so the fake serves them as plain
// row arrays keyed by table name; an unlisted table reads as empty.
function fakeClient(initialRows: Row[], otherTables: Record<string, unknown[]> = {}) {
  const rows: Row[] = [...initialRows];
  let idCounter = rows.length;

  function applyFilters(filters: [string, string][]) {
    return rows.filter((r) => filters.every(([col, val]) => (r as never)[col] === val));
  }

  function chain(filters: [string, string][], table: string) {
    // Thenable as well as chainable, mirroring a PostgREST builder: the sweep
    // awaits `select("*")` directly, while every other read still chains
    // .eq()/.limit() off it.
    return {
      then(resolve: (value: { data: unknown[]; error: null }) => unknown) {
        const data = table === "brand_assets" ? applyFilters(filters) : (otherTables[table] ?? []);
        return Promise.resolve({ data, error: null }).then(resolve);
      },
      eq(column: string, value: string) {
        return chain([...filters, [column, value]], table);
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
    from(table: string = "brand_assets") {
      return {
        select(_cols: string) {
          return chain([], table);
        },
        delete() {
          return {
            eq(column: string, value: string) {
              for (let i = rows.length - 1; i >= 0; i--) {
                if ((rows[i] as never)[column] === value) rows.splice(i, 1);
              }
              return Promise.resolve({ error: null });
            },
          };
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

  it("re-files an asset onto another slug", async () => {
    const client = fakeClient([baseRow({ id: "a1", variant: "square-paper" })]);
    await updateAssetMeta(client as never, "a1", { variant: "wide-indigo" });

    const row = client.rows.find((r) => r.id === "a1")!;
    expect(row.variant).toBe("wide-indigo");
  });

  it("normalizes a slug typed as prose", async () => {
    const client = fakeClient([baseRow({ id: "a1" })]);
    await updateAssetMeta(client as never, "a1", { variant: "  Square Paper  " });

    expect(client.rows.find((r) => r.id === "a1")!.variant).toBe("square-paper");
  });

  it("allows moving onto a slug another FORMAT already occupies", async () => {
    // The whole point of the slug: an SVG and a PNG of one variation share it
    // and land on one card. Only same-format approved rows collide.
    const client = fakeClient([
      baseRow({ id: "svg", variant: "square-paper", format: "svg", status: "approved" }),
      baseRow({ id: "png", variant: "stray", format: "png", status: "approved" }),
    ]);
    await updateAssetMeta(client as never, "png", { variant: "square-paper" });

    expect(client.rows.find((r) => r.id === "png")!.variant).toBe("square-paper");
  });

  it("refuses a move that would put two approved files of one format on a slug", async () => {
    const client = fakeClient([
      baseRow({ id: "a", variant: "square-paper", format: "svg", status: "approved" }),
      baseRow({ id: "b", variant: "wide-indigo", format: "svg", status: "approved" }),
    ]);

    await expect(
      updateAssetMeta(client as never, "b", { variant: "square-paper" }),
    ).rejects.toThrow(/already has an approved SVG/);
    expect(client.rows.find((r) => r.id === "b")!.variant).toBe("wide-indigo");
  });

  it("lets a DRAFT move onto a slug whose same-format file is approved", async () => {
    // A draft replacement for an approved file has to be able to sit on the
    // same slug — approveAsset archives the incumbent at approve time.
    const client = fakeClient([
      baseRow({ id: "live", variant: "square-paper", format: "svg", status: "approved" }),
      baseRow({ id: "new", variant: "scratch", format: "svg", status: "draft" }),
    ]);
    await updateAssetMeta(client as never, "new", { variant: "square-paper" });

    expect(client.rows.find((r) => r.id === "new")!.variant).toBe("square-paper");
  });
});

describe("normalizeVariant", () => {
  it("lowercases, trims and hyphenates so one variation stays one card", () => {
    expect(normalizeVariant("  Square Paper ")).toBe("square-paper");
    expect(normalizeVariant("square_paper")).toBe("square-paper");
    expect(normalizeVariant("Square  --  Paper")).toBe("square-paper");
  });

  it("falls back to 'default' for an empty or punctuation-only slug", () => {
    expect(normalizeVariant("")).toBe("default");
    expect(normalizeVariant(null)).toBe("default");
    expect(normalizeVariant("///")).toBe("default");
  });
});

describe("deleteAsset", () => {
  it("removes an archived, unreferenced asset and returns it for storage cleanup", async () => {
    const client = fakeClient([
      baseRow({ id: "gone", status: "archived", storage_path: "wordmark/gone.svg" }),
      baseRow({ id: "keep", status: "approved" }),
    ]);

    const removed = await deleteAsset(client as never, "gone");

    // The row's storage_path is what the route needs to delete the bytes, so it
    // has to come back from the same call that proved the delete was allowed.
    expect(removed.storage_path).toBe("wordmark/gone.svg");
    expect(client.rows.map((r) => r.id)).toEqual(["keep"]);
  });

  it("refuses to delete an approved or draft asset", async () => {
    // Archiving is the reversible retirement step, and going through it first
    // is what stops a live mark disappearing in one click.
    const client = fakeClient([
      baseRow({ id: "live", status: "approved" }),
      baseRow({ id: "wip", status: "draft" }),
    ]);

    await expect(deleteAsset(client as never, "live")).rejects.toThrow(/Archive this asset/);
    await expect(deleteAsset(client as never, "wip")).rejects.toThrow(/Archive this asset/);
    expect(client.rows).toHaveLength(2);
  });

  it("refuses when a real FK column still names the asset", async () => {
    // brand_labels.chop_glyph_asset_id is ON DELETE SET NULL, so Postgres would
    // accept this delete and silently blank the label's chop.
    const client = fakeClient([baseRow({ id: "chop", status: "archived" })], {
      brand_labels: [{ id: "l1", name: "Epic Hazy", chop_glyph_asset_id: "chop" }],
    });

    await expect(deleteAsset(client as never, "chop")).rejects.toThrow(/label "Epic Hazy"/);
    expect(client.rows).toHaveLength(1);
  });

  it("refuses when only an unconstrained jsonb reference names the asset", async () => {
    // No FK protects motif_set / asset_refs / canon assetIds at all — these are
    // the references the sweep exists for.
    const client = fakeClient([baseRow({ id: "motif", status: "archived" })], {
      brand_seasons: [{ id: "s1", name: "Autumn 2026", motif_set: [{ assetId: "motif" }] }],
    });

    await expect(deleteAsset(client as never, "motif")).rejects.toThrow(/season "Autumn 2026"/);
  });

  it("names every referencing row, so one delete surfaces all the work", async () => {
    const client = fakeClient([baseRow({ id: "x", status: "archived" })], {
      brand_labels: [{ id: "l1", name: "Epic Hazy", chop_glyph_asset_id: "x" }],
      brand_outputs: [{ id: "o1", rendition: "can-16oz", asset_refs: [{ slot: "chop", assetId: "x" }] }],
    });

    await expect(deleteAsset(client as never, "x")).rejects.toThrow(
      /label "Epic Hazy".*output "can-16oz"/,
    );
  });

  it("throws for an unknown id rather than reporting a silent no-op", async () => {
    const client = fakeClient([]);
    await expect(deleteAsset(client as never, "nope")).rejects.toThrow(/Asset not found/);
  });
});
