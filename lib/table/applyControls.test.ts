import { describe, it, expect } from "vitest";
import { applyControls } from "./applyControls";
import type { ControlsConfig, ControlsState } from "./types";

interface Row {
  recipe: string;
  partner: string | null;
  status: string;
  volume: number;
}

const ROWS: Row[] = [
  { recipe: "Hazy IPA", partner: "Acme", status: "open", volume: 10 },
  { recipe: "Stout", partner: "Beta Co", status: "closed", volume: 2 },
  { recipe: "Pilsner", partner: null, status: "open", volume: 30 },
];

const CONFIG: ControlsConfig<Row> = {
  search: [
    { param: "q", accessor: (r) => r.recipe },
    { param: "q_blend", accessor: (r) => [r.recipe, r.partner] },
  ],
  filters: [
    { param: "status", accessor: (r) => r.status },
    { param: "partner", accessor: (r) => r.partner ?? "", multi: true },
  ],
  sort: { columns: [{ key: "volume", accessor: (r) => r.volume }, { key: "recipe", accessor: (r) => r.recipe }] },
};

const EMPTY: ControlsState = { search: {}, filters: {}, sort: null };

describe("applyControls", () => {
  it("returns all rows when state is empty", () => {
    expect(applyControls(ROWS, CONFIG, EMPTY)).toHaveLength(3);
  });

  it("text search is case-insensitive substring on the coded field", () => {
    const out = applyControls(ROWS, CONFIG, { ...EMPTY, search: { q: "ipa" } });
    expect(out.map((r) => r.recipe)).toEqual(["Hazy IPA"]);
  });

  it("blank / whitespace query does not filter", () => {
    expect(applyControls(ROWS, CONFIG, { ...EMPTY, search: { q: "   " } })).toHaveLength(3);
  });

  it("identity-blend search ORs across the box's fields", () => {
    const out = applyControls(ROWS, CONFIG, { ...EMPTY, search: { q_blend: "beta" } });
    expect(out.map((r) => r.recipe)).toEqual(["Stout"]); // matched on partner
  });

  it("categorical filter keeps only matching rows", () => {
    const out = applyControls(ROWS, CONFIG, { ...EMPTY, filters: { status: ["open"] } });
    expect(out.map((r) => r.recipe)).toEqual(["Hazy IPA", "Pilsner"]);
  });

  it("empty filter array = All (no filtering)", () => {
    expect(applyControls(ROWS, CONFIG, { ...EMPTY, filters: { status: [] } })).toHaveLength(3);
  });

  it("multi-select filter ORs across selected values", () => {
    const out = applyControls(ROWS, CONFIG, { ...EMPTY, filters: { partner: ["Acme", "Beta Co"] } });
    expect(out.map((r) => r.recipe)).toEqual(["Hazy IPA", "Stout"]);
  });

  it("search and filter combine with AND", () => {
    const out = applyControls(ROWS, CONFIG, { ...EMPTY, search: { q: "s" }, filters: { status: ["open"] } });
    expect(out.map((r) => r.recipe)).toEqual(["Pilsner"]); // Pilsner matches 's' and open
  });

  it("sorts numbers ascending and descending", () => {
    const asc = applyControls(ROWS, CONFIG, { ...EMPTY, sort: { key: "volume", dir: "asc" } });
    expect(asc.map((r) => r.volume)).toEqual([2, 10, 30]);
    const desc = applyControls(ROWS, CONFIG, { ...EMPTY, sort: { key: "volume", dir: "desc" } });
    expect(desc.map((r) => r.volume)).toEqual([30, 10, 2]);
  });

  it("sorts strings via localeCompare", () => {
    const out = applyControls(ROWS, CONFIG, { ...EMPTY, sort: { key: "recipe", dir: "asc" } });
    expect(out.map((r) => r.recipe)).toEqual(["Hazy IPA", "Pilsner", "Stout"]);
  });

  it("unknown sort key leaves order unchanged", () => {
    const out = applyControls(ROWS, CONFIG, { ...EMPTY, sort: { key: "nope", dir: "asc" } });
    expect(out.map((r) => r.recipe)).toEqual(["Hazy IPA", "Stout", "Pilsner"]);
  });

  it("does not mutate the input array", () => {
    const copy = [...ROWS];
    applyControls(ROWS, CONFIG, { ...EMPTY, sort: { key: "volume", dir: "desc" } });
    expect(ROWS).toEqual(copy);
  });

  it("coerce(null/undefined) to empty string and sorts before non-empty strings", () => {
    interface LocalRow {
      id: string;
      tag: string | null | undefined;
    }

    const localRows: LocalRow[] = [
      { id: "a", tag: "zebra" },
      { id: "b", tag: null },
      { id: "c", tag: "apple" },
      { id: "d", tag: undefined },
    ];

    const localConfig: ControlsConfig<LocalRow> = {
      sort: {
        columns: [{ key: "tag", accessor: (r) => r.tag }],
      },
    };

    const sorted = applyControls(localRows, localConfig, {
      search: {},
      filters: {},
      sort: { key: "tag", dir: "asc" },
    });

    // null and undefined both coerce to "", so they sort first (in stable order)
    // followed by "apple", then "zebra"
    expect(sorted.map((r) => r.id)).toEqual(["b", "d", "c", "a"]);
  });

  it("uses a custom matches predicate when provided", () => {
    const cfg: ControlsConfig<Row> = {
      filters: [
        {
          param: "vol",
          matches: (r, sel) => sel.some((s) => (s === "big" ? r.volume >= 10 : r.volume < 10)),
        },
      ],
    };
    const out = applyControls(ROWS, cfg, { ...EMPTY, filters: { vol: ["big"] } });
    expect(out.map((r) => r.recipe)).toEqual(["Hazy IPA", "Pilsner"]);
  });

  it("matches predicate with empty selection does not filter", () => {
    const cfg: ControlsConfig<Row> = {
      filters: [{ param: "vol", matches: () => false }],
    };
    expect(applyControls(ROWS, cfg, { ...EMPTY, filters: { vol: [] } })).toHaveLength(3);
  });
});
