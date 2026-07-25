import { describe, it, expect } from "vitest";
import { matchesGlFilter, narrowToGl } from "./glLineMatch";

interface Line { id: string; coa: string | null }
const coaOf = (l: Line) => l.coa;

const lines: Line[] = [
  { id: "a", coa: "utilities" },
  { id: "b", coa: "supplies" },
  { id: "c", coa: null },
  { id: "d", coa: "utilities" },
];

describe("matchesGlFilter", () => {
  it("matches everything when nothing is selected", () => {
    expect(matchesGlFilter(["supplies"], [])).toBe(true);
    expect(matchesGlFilter([], [])).toBe(true);
  });

  it("matches when any line carries a selected account", () => {
    expect(matchesGlFilter(["supplies", "utilities"], ["utilities"])).toBe(true);
  });

  it("does not match when no line carries a selected account", () => {
    expect(matchesGlFilter(["supplies", "rent"], ["utilities"])).toBe(false);
  });

  it("ignores unmapped lines rather than treating them as a match", () => {
    expect(matchesGlFilter([null, undefined], ["utilities"])).toBe(false);
  });

  it("does not match a row with no lines at all", () => {
    expect(matchesGlFilter([], ["utilities"])).toBe(false);
  });

  it("matches on any of several selected accounts", () => {
    expect(matchesGlFilter(["rent"], ["utilities", "rent"])).toBe(true);
  });
});

describe("narrowToGl", () => {
  it("returns every line when nothing is selected", () => {
    expect(narrowToGl(lines, coaOf, [])).toEqual(lines);
  });

  it("keeps only the matching lines, in their original order", () => {
    expect(narrowToGl(lines, coaOf, ["utilities"]).map((l) => l.id)).toEqual(["a", "d"]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(narrowToGl(lines, coaOf, ["rent"])).toEqual([]);
  });

  it("drops unmapped lines when a filter is active", () => {
    expect(narrowToGl(lines, coaOf, ["supplies"]).map((l) => l.id)).toEqual(["b"]);
  });

  it("handles an empty input list", () => {
    expect(narrowToGl([], coaOf, ["utilities"])).toEqual([]);
  });
});
