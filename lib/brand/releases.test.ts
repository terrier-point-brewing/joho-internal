import { describe, expect, it } from "vitest";
import {
  archiveRelease,
  cardComponentStatus,
  codesComponentStatus,
  createRelease,
  getRelease,
  listReleases,
  markReleased,
  recipeComponentStatus,
  updateRelease,
  type BrandRelease,
} from "./releases";

const CRITERIA = ["Ownable?", "Pronounceable?"];

const baseRelease = (overrides: Partial<BrandRelease> = {}): BrandRelease => ({
  id: "r1",
  name: "Ah-Mah's Stove",
  story_line: null,
  menu_description: null,
  naming_check: { results: [] },
  season_id: null,
  episode: null,
  recipe_id: null,
  status: "draft",
  created_at: "2026-08-01T00:00:00Z",
  released_at: null,
  ...overrides,
});

describe("recipeComponentStatus", () => {
  it("is not_started without a linked recipe", () => {
    expect(recipeComponentStatus(baseRelease())).toBe("not_started");
  });

  it("is done once a recipe is linked", () => {
    expect(recipeComponentStatus(baseRelease({ recipe_id: "rec-1" }))).toBe("done");
  });
});

describe("cardComponentStatus", () => {
  const complete = baseRelease({
    story_line: "The brick stove, the kettle, low light.",
    menu_description: "A jasmine peach lager.",
    season_id: "s1",
    episode: 4,
    naming_check: {
      results: [
        { criterion: "Ownable?", pass: true },
        { criterion: "Pronounceable?", pass: true },
      ],
    },
  });

  it("is not_started on a bare release", () => {
    expect(cardComponentStatus(baseRelease(), CRITERIA)).toBe("not_started");
  });

  it("is in_progress once any card field is filled", () => {
    expect(cardComponentStatus(baseRelease({ story_line: "…" }), CRITERIA)).toBe("in_progress");
    expect(cardComponentStatus(baseRelease({ season_id: "s1" }), CRITERIA)).toBe("in_progress");
  });

  it("is done when all fields are set and every criterion passes", () => {
    expect(cardComponentStatus(complete, CRITERIA)).toBe("done");
  });

  it("drops back to in_progress when the canon grows a new criterion", () => {
    expect(cardComponentStatus(complete, [...CRITERIA, "Specific referent?"])).toBe("in_progress");
  });

  it("is never done with an empty criteria list", () => {
    expect(cardComponentStatus(complete, [])).toBe("in_progress");
  });

  it("ignores stale naming results for criteria no longer in the canon", () => {
    const stale = baseRelease({
      ...complete,
      naming_check: {
        results: [
          { criterion: "Ownable?", pass: true },
          { criterion: "Pronounceable?", pass: true },
          { criterion: "Removed criterion", pass: false },
        ],
      },
    });
    expect(cardComponentStatus(stale, CRITERIA)).toBe("done");
  });
});

describe("codesComponentStatus", () => {
  it("hasn't started without a recipe or without variations", () => {
    expect(codesComponentStatus(false, [])).toBe("not_started");
    expect(codesComponentStatus(true, [])).toBe("not_started");
    expect(codesComponentStatus(false, [{ product_code: "123" }])).toBe("not_started");
  });

  it("is in_progress when some containers are coded", () => {
    expect(codesComponentStatus(true, [{ product_code: "123" }, { product_code: null }])).toBe("in_progress");
  });

  it("is not_started when containers exist but none are coded", () => {
    expect(codesComponentStatus(true, [{ product_code: null }])).toBe("not_started");
  });

  it("is done when every container is coded", () => {
    expect(codesComponentStatus(true, [{ product_code: "123" }, { product_code: "456" }])).toBe("done");
  });
});

// Minimal fake Supabase-like client, mirroring labels.test.ts's fakeClient.
interface Row extends BrandRelease {
  [key: string]: unknown;
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
      order() {
        return Promise.resolve({
          data: [...applyFilters(filters)].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)),
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
        select() {
          return chain([]);
        },
        insert(row: Partial<Row>) {
          return {
            select() {
              return {
                single() {
                  const newRow = { id: `id-${idCounter++}`, created_at: `2026-08-0${idCounter}` , ...row } as Row;
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

describe("listReleases / getRelease", () => {
  it("lists all releases and filters by status", async () => {
    const client = fakeClient([
      baseRelease({ id: "r1" }) as Row,
      baseRelease({ id: "r2", status: "released" }) as Row,
    ]);
    expect(await listReleases(client as never)).toHaveLength(2);
    const released = await listReleases(client as never, { status: "released" });
    expect(released.map((r) => r.id)).toEqual(["r2"]);
  });

  it("getRelease returns the row or null", async () => {
    const client = fakeClient([baseRelease({ id: "r1" }) as Row]);
    expect((await getRelease(client as never, "r1"))?.id).toBe("r1");
    expect(await getRelease(client as never, "missing")).toBeNull();
  });
});

describe("createRelease", () => {
  it("inserts a draft with empty card fields and naming check", async () => {
    const client = fakeClient([]);
    const created = await createRelease(client as never, { name: "New Release" });
    expect(created.status).toBe("draft");
    expect(created.naming_check).toEqual({ results: [] });
    expect(created.recipe_id).toBeNull();
    expect(client.rows).toHaveLength(1);
  });
});

describe("updateRelease / markReleased / archiveRelease", () => {
  it("applies a field patch", async () => {
    const client = fakeClient([baseRelease({ id: "r1" }) as Row]);
    await updateRelease(client as never, "r1", { story_line: "New story", episode: 2 });
    const row = client.rows.find((r) => r.id === "r1");
    expect(row?.story_line).toBe("New story");
    expect(row?.episode).toBe(2);
  });

  it("markReleased flips status and stamps released_at; releases coexist", async () => {
    const client = fakeClient([
      baseRelease({ id: "r1", status: "released" }) as Row,
      baseRelease({ id: "r2" }) as Row,
    ]);
    await markReleased(client as never, "r2");
    expect(client.rows.find((r) => r.id === "r1")?.status).toBe("released");
    const r2 = client.rows.find((r) => r.id === "r2");
    expect(r2?.status).toBe("released");
    expect(r2?.released_at).toBeTruthy();
  });

  it("archiveRelease sets status to archived", async () => {
    const client = fakeClient([baseRelease({ id: "r1", status: "released" }) as Row]);
    await archiveRelease(client as never, "r1");
    expect(client.rows.find((r) => r.id === "r1")?.status).toBe("archived");
  });
});
