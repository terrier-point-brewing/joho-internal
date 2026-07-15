import { describe, it, expect } from "vitest";
import { mappingState, matchesMappingFilter } from "./mappingStatus";

describe("mappingState", () => {
  it("returns 'empty' when there are no children", () => {
    expect(mappingState(0, 0)).toBe("empty");
  });
  it("returns 'mapped' when every child is mapped", () => {
    expect(mappingState(3, 3)).toBe("mapped");
    // Defensive: mapped over-count still reads as fully mapped.
    expect(mappingState(4, 3)).toBe("mapped");
  });
  it("returns 'partial' when some but not all children are mapped", () => {
    expect(mappingState(1, 3)).toBe("partial");
  });
  it("returns 'unmapped' when no child is mapped", () => {
    expect(mappingState(0, 3)).toBe("unmapped");
  });
  it("returns 'accepted' when accepted and not fully mapped", () => {
    expect(mappingState(1, 3, true)).toBe("accepted");
    expect(mappingState(0, 3, true)).toBe("accepted");
  });
  it("returns 'mapped' when fully mapped, even if accepted is stale-true", () => {
    expect(mappingState(3, 3, true)).toBe("mapped");
  });
  it("returns 'empty' when there are no children, regardless of accepted", () => {
    expect(mappingState(0, 0, true)).toBe("empty");
  });
});

describe("matchesMappingFilter", () => {
  it("'all' matches everything", () => {
    expect(matchesMappingFilter("all", 0, 0)).toBe(true);
    expect(matchesMappingFilter("all", 1, 3)).toBe(true);
  });
  it("childless records only satisfy the 'unmapped' bucket", () => {
    expect(matchesMappingFilter("unmapped", 0, 0)).toBe(true);
    expect(matchesMappingFilter("mapped", 0, 0)).toBe(false);
    expect(matchesMappingFilter("partial", 0, 0)).toBe(false);
  });
  it("matches the concrete mapping state otherwise", () => {
    expect(matchesMappingFilter("mapped", 3, 3)).toBe(true);
    expect(matchesMappingFilter("partial", 1, 3)).toBe(true);
    expect(matchesMappingFilter("unmapped", 0, 3)).toBe(true);
    expect(matchesMappingFilter("mapped", 1, 3)).toBe(false);
  });
  it("matches the 'accepted' bucket, and excludes accepted rows from 'unmapped'", () => {
    expect(matchesMappingFilter("accepted", 1, 3, true)).toBe(true);
    expect(matchesMappingFilter("unmapped", 1, 3, true)).toBe(false);
    // Fully-mapped-but-stale-accepted-flag row reads as "mapped", not "accepted".
    expect(matchesMappingFilter("accepted", 3, 3, true)).toBe(false);
  });
});
