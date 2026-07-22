import { describe, expect, it } from "vitest";
import { getDraft, listVersions, nextVersionLabel, publishDraft, saveDraft } from "./canonWorkflow";
import { seedCanon } from "./seedCanon";
import type { BrandCanon } from "./canon.types";

describe("nextVersionLabel", () => {
  it("returns 1.0 when current is null", () => {
    expect(nextVersionLabel(null)).toBe("1.0");
  });

  it("bumps the minor version", () => {
    expect(nextVersionLabel("1.0")).toBe("1.1");
  });

  it("bumps the minor version as an integer past single digits", () => {
    expect(nextVersionLabel("1.9")).toBe("1.10");
  });
});

// A minimal fake Supabase-like client covering the query shapes canonWorkflow
// needs: from().select().eq().limit() (read; also used by saveDraft to check
// for an existing draft), from().insert() (saveDraft's insert path,
// publishDraft's new published/archived rows), from().update().eq()
// (saveDraft's update path, publishDraft's archive step),
// from().delete().eq() (publishDraft removing the draft row), and
// from().select().in().order() (listVersions). Configurable per test via
// `rows` (the current table contents) so each function can be driven
// end-to-end against fake state.
interface Row {
  id: string;
  version_label: string;
  status: "draft" | "published" | "archived";
  document: unknown;
  changelog?: string;
  published_at?: string | null;
}

function fakeClient(initialRows: Row[]) {
  const rows: Row[] = [...initialRows];
  let idCounter = rows.length;

  return {
    rows,
    from() {
      return {
        select(_cols: string) {
          return {
            eq(column: string, value: string) {
              const filtered = rows.filter((r) => (r as never)[column] === value);
              return {
                limit(n: number) {
                  return Promise.resolve({ data: filtered.slice(0, n), error: null });
                },
              };
            },
            in(column: string, values: string[]) {
              const filtered = rows.filter((r) => values.includes((r as never)[column]));
              return {
                order() {
                  return Promise.resolve({
                    data: [...filtered].sort((a, b) => (a.published_at ?? "") < (b.published_at ?? "") ? 1 : -1),
                    error: null,
                  });
                },
              };
            },
          };
        },
        insert(row: Partial<Row>) {
          // Enforce the brand_canon_one_published partial unique index so a
          // publish that inserts a 2nd published row before archiving the
          // prior one fails here (as it would in Postgres).
          if (row.status === "published" && rows.some((r) => r.status === "published")) {
            return Promise.resolve({ error: new Error("duplicate published row (one-published index)") });
          }
          rows.push({ id: `id-${idCounter++}`, ...row } as Row);
          return Promise.resolve({ error: null });
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
        delete() {
          return {
            eq(column: string, value: string) {
              const idx = rows.findIndex((r) => (r as never)[column] === value);
              if (idx >= 0) rows.splice(idx, 1);
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  };
}

describe("getDraft", () => {
  it("returns the existing draft row's document", async () => {
    const custom: BrandCanon = { ...seedCanon, brandName: "Existing Draft" };
    const client = fakeClient([{ id: "d1", version_label: "1.0", status: "draft", document: custom }]);
    const result = await getDraft(client as never);
    expect(result.brandName).toBe("Existing Draft");
  });

  it("seeds a new draft from the current published row when none exists", async () => {
    const published: BrandCanon = { ...seedCanon, brandName: "Published" };
    const client = fakeClient([
      { id: "p1", version_label: "1.0", status: "published", document: published, published_at: "2026-01-01" },
    ]);
    const result = await getDraft(client as never);
    expect(result.brandName).toBe("Published");
    expect(client.rows.some((r) => r.status === "draft")).toBe(true);
  });

  it("seeds a new draft from seedCanon when no rows at all exist", async () => {
    const client = fakeClient([]);
    const result = await getDraft(client as never);
    expect(result).toEqual(seedCanon);
    expect(client.rows.some((r) => r.status === "draft")).toBe(true);
  });
});

describe("saveDraft", () => {
  it("updates the existing draft in place without creating a second draft", async () => {
    const client = fakeClient([{ id: "d1", version_label: "1.0", status: "draft", document: seedCanon }]);
    const updated: BrandCanon = { ...seedCanon, brandName: "Updated" };
    await saveDraft(client as never, updated);
    const draftRows = client.rows.filter((r) => r.status === "draft");
    expect(draftRows).toHaveLength(1);
    expect((draftRows[0]?.document as BrandCanon).brandName).toBe("Updated");
  });

  it("inserts a draft when none exists yet", async () => {
    const client = fakeClient([]);
    const updated: BrandCanon = { ...seedCanon, brandName: "Fresh" };
    await saveDraft(client as never, updated);
    const draftRows = client.rows.filter((r) => r.status === "draft");
    expect(draftRows).toHaveLength(1);
    expect((draftRows[0]?.document as BrandCanon).brandName).toBe("Fresh");
  });

  it("rejects an invalid document", async () => {
    const client = fakeClient([{ id: "d1", version_label: "1.0", status: "draft", document: seedCanon }]);
    const { mission: _mission, ...invalid } = seedCanon;
    await expect(saveDraft(client as never, invalid)).rejects.toThrow();
  });
});

describe("publishDraft", () => {
  it("publishes the draft, archives the prior published row, and deletes the draft", async () => {
    const client = fakeClient([
      { id: "p1", version_label: "1.0", status: "published", document: seedCanon, published_at: "2026-01-01" },
      { id: "d1", version_label: "", status: "draft", document: { ...seedCanon, brandName: "Draft Edit" } },
    ]);
    const result = await publishDraft(client as never, {});
    expect(result.versionLabel).toBe("1.1");
    expect(client.rows.some((r) => r.status === "draft")).toBe(false);
    expect(client.rows.find((r) => r.id === "p1")?.status).toBe("archived");
    const published = client.rows.find((r) => r.status === "published");
    expect((published?.document as BrandCanon).brandName).toBe("Draft Edit");
    expect(published?.version_label).toBe("1.1");
  });
});

describe("listVersions", () => {
  it("returns published and archived rows, newest first", async () => {
    const client = fakeClient([
      { id: "p1", version_label: "1.0", status: "archived", document: seedCanon, published_at: "2026-01-01" },
      { id: "p2", version_label: "1.1", status: "published", document: seedCanon, published_at: "2026-02-01" },
    ]);
    const result = await listVersions(client as never);
    expect(result.map((r) => r.version_label)).toEqual(["1.1", "1.0"]);
  });
});
