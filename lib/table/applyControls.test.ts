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

  describe("search narrowing", () => {
    interface Card { id: string; lines: { beer: string }[] }
    const CARDS: Card[] = [
      { id: "a", lines: [{ beer: "Hazy IPA" }, { beer: "Stout" }] },
      { id: "b", lines: [{ beer: "Pilsner" }] },
    ];
    const NARROW: ControlsConfig<Card> = {
      search: [{
        param: "q",
        accessor: (c) => c.lines.map((l) => l.beer),
        narrow: (c, matches) => ({ ...c, lines: c.lines.filter((l) => matches(l.beer)) }),
      }],
    };

    it("drops the sub-items that did not match", () => {
      const out = applyControls(CARDS, NARROW, { ...EMPTY, search: { q: "hazy" } });
      expect(out).toHaveLength(1);
      expect(out[0].lines.map((l) => l.beer)).toEqual(["Hazy IPA"]);
    });

    it("leaves rows untouched when the query is blank", () => {
      const out = applyControls(CARDS, NARROW, { ...EMPTY, search: { q: "  " } });
      expect(out).toBe(CARDS);
    });

    it("does not mutate the source rows", () => {
      applyControls(CARDS, NARROW, { ...EMPTY, search: { q: "hazy" } });
      expect(CARDS[0].lines).toHaveLength(2);
    });

    it("a surviving row always keeps at least one sub-item", () => {
      const out = applyControls(CARDS, NARROW, { ...EMPTY, search: { q: "s" } });
      expect(out.every((c) => c.lines.length > 0)).toBe(true);
    });
  });

  it("matches predicate with empty selection does not filter", () => {
    const cfg: ControlsConfig<Row> = {
      filters: [{ param: "vol", matches: () => false }],
    };
    expect(applyControls(ROWS, cfg, { ...EMPTY, filters: { vol: [] } })).toHaveLength(3);
  });

  describe("coerce date/alpha sort", () => {
    interface DateRow {
      id: string;
      createdAt: string;
    }

    const DATE_ROWS: DateRow[] = [
      { id: "mid", createdAt: "2026-07-09" },
      { id: "early", createdAt: "2026-01-05" },
      { id: "late", createdAt: "2026-07-10" },
      { id: "timestamp", createdAt: "2026-07-09T14:23:11Z" },
    ];

    const DATE_CONFIG: ControlsConfig<DateRow> = {
      sort: { columns: [{ key: "createdAt", accessor: (r) => r.createdAt }] },
    };

    it("sorts ISO date strings (same-year, different days) chronologically ascending", () => {
      const out = applyControls(DATE_ROWS, DATE_CONFIG, { ...EMPTY, sort: { key: "createdAt", dir: "asc" } });
      expect(out.map((r) => r.id)).toEqual(["early", "mid", "timestamp", "late"]);
    });

    it("sorts ISO date strings chronologically descending", () => {
      const out = applyControls(DATE_ROWS, DATE_CONFIG, { ...EMPTY, sort: { key: "createdAt", dir: "desc" } });
      expect(out.map((r) => r.id)).toEqual(["late", "timestamp", "mid", "early"]);
    });

    interface LabelRow {
      id: string;
      label: string;
    }

    const ALPHA_LABEL_ROWS: LabelRow[] = [
      { id: "amber", label: "Amber" },
      { id: "eight", label: "8 Ball" },
      { id: "ten", label: "10 Barrel" },
    ];

    const ALPHA_CONFIG: ControlsConfig<LabelRow> = {
      sort: { columns: [{ key: "label", accessor: (r) => r.label }] },
    };

    it("sorts numeric-leading text alphabetically, not as numbers", () => {
      const out = applyControls(ALPHA_LABEL_ROWS, ALPHA_CONFIG, { ...EMPTY, sort: { key: "label", dir: "asc" } });
      // localeCompare, case-insensitive (coerce lowercases): "10 barrel" < "8 ball" < "amber"
      expect(out.map((r) => r.label)).toEqual(["10 Barrel", "8 Ball", "Amber"]);
    });

    const NUMERIC_LABEL_ROWS: LabelRow[] = [
      { id: "b", label: "2" },
      { id: "c", label: "10" },
      { id: "a", label: "1" },
    ];

    it("sorts pure numeric strings numerically, not lexically", () => {
      const out = applyControls(NUMERIC_LABEL_ROWS, ALPHA_CONFIG, { ...EMPTY, sort: { key: "label", dir: "asc" } });
      expect(out.map((r) => r.label)).toEqual(["1", "2", "10"]);
      // NOTE: NUMERIC_LABEL_ROWS reused with ALPHA_CONFIG's "label" key intentionally.
    });
  });
});
