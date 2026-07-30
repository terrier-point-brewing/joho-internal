import { describe, expect, it } from "vitest";
import { diffCanon, renderChangelog } from "./diffCanon";
import { withIds } from "./canonIds";
import { seedCanon } from "./seedCanon";
import type { BrandCanon } from "./canon.types";

// Every test starts from an id-bearing canon — diffCanon matches list items by
// id, which is the whole reason ids exist.
const base = withIds(seedCanon).canon;
const clone = (c: BrandCanon) => structuredClone(c);

describe("diffCanon", () => {
  it("reports nothing for an unchanged canon", () => {
    expect(diffCanon(base, clone(base))).toEqual([]);
  });

  it("reports a changed palette hex once, with before and after", () => {
    const next = clone(base);
    next.palette[2].hex = "#a51829";

    const entries = diffCanon(base, next);

    expect(entries).toHaveLength(1);
    expect(entries[0].section).toBe("color");
    expect(entries[0].kind).toBe("changed");
    expect(entries[0].before).toBe("#ad1a2d");
    expect(entries[0].after).toBe("#a51829");
    expect(entries[0].label).toContain("Seal Red");
  });

  it("reports ZERO entries when a list is only reordered", () => {
    const next = clone(base);
    next.values = [next.values[2], next.values[0], next.values[1], next.values[3], next.values[4]];

    // The regression this module exists to prevent: index-based diffing would
    // report five changes here.
    expect(diffCanon(base, next)).toEqual([]);
  });

  it("reports an added list item as one 'added' entry", () => {
    const next = clone(base);
    next.values.push({ id: "new-value", n: "6", title: "Sixth value", means: "m", cost: "c" });

    const entries = diffCanon(base, next);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("added");
    expect(entries[0].section).toBe("ethos");
    expect(entries[0].label).toContain("Sixth value");
  });

  it("reports a removed list item as one 'removed' entry", () => {
    const next = clone(base);
    const dropped = next.values[1].title;
    next.values.splice(1, 1);

    const entries = diffCanon(base, next);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("removed");
    expect(entries[0].label).toContain(dropped);
  });

  it("reports a rename as 'changed', never as add plus remove", () => {
    const next = clone(base);
    next.values[0].title = "Completely different title";

    const entries = diffCanon(base, next);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("changed");
    expect(entries.some((e) => e.kind === "added" || e.kind === "removed")).toBe(false);
  });

  it("reports one entry per differing field on the same item", () => {
    const next = clone(base);
    next.palette[0].hex = "#111111";
    next.palette[0].name = "Renamed";

    const entries = diffCanon(base, next);
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((e) => e.kind))).toEqual(new Set(["changed"]));
  });

  it("attributes each entry to the subtab that owns it", () => {
    const next = clone(base);
    next.values[0].cost = "different cost";
    next.voice.neverWords = [...next.voice.neverWords, "synergy"];
    next.hardRules = [...next.hardRules, "A new hard rule"];

    const entries = diffCanon(base, next);
    const sections = new Set(entries.map((e) => e.section));
    expect(sections).toEqual(new Set(["ethos", "voice", "agent"]));
  });

  it("treats a first publish (prev null) as one entry per populated section", () => {
    const entries = diffCanon(null, base);

    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.kind === "added")).toBe(true);
    // One per section, not one per field.
    expect(entries.length).toBeLessThanOrEqual(7);
    expect(new Set(entries.map((e) => e.section)).size).toBe(entries.length);
  });

  it("detects a scalar change inside a nested object", () => {
    const next = clone(base);
    next.roleMap.light.accent = "camphor";

    const entries = diffCanon(base, next);
    expect(entries).toHaveLength(1);
    expect(entries[0].section).toBe("color");
    expect(entries[0].path).toContain("accent");
  });

  it("names what was added to a plain string list, not a count", () => {
    const next = clone(base);
    next.colorForbidden = [...next.colorForbidden, "No neon anything."];

    const entries = diffCanon(base, next);
    expect(entries).toHaveLength(1);
    expect(entries[0].section).toBe("color");
    expect(entries[0].kind).toBe("added");
    expect(entries[0].label).toContain("No neon anything.");
    // "10 items → 11 items" tells a reader nothing.
    expect(entries[0].label).not.toMatch(/\d+ items/);
  });

  it("names what was removed from a plain string list", () => {
    const next = clone(base);
    const dropped = next.hardRules[0];
    next.hardRules = next.hardRules.slice(1);

    const entries = diffCanon(base, next);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("removed");
    expect(entries[0].label).toContain(dropped.slice(0, 20));
  });

  it("labels a rename by the item's PREVIOUS name", () => {
    const next = clone(base);
    next.palette[2].name = "Chop Red";

    const entries = diffCanon(base, next);
    // Not "Chop Red name: Seal Red → Chop Red", which reads as nonsense.
    expect(entries[0].label).toBe("Seal Red name: Seal Red → Chop Red");
  });

  it("identifies a font by its role rather than its family", () => {
    const next = clone(base);
    next.fonts[0].family = "Lato";

    const entries = diffCanon(base, next);
    expect(entries[0].label).toContain("display");
  });

  it("summarises an intro rewrite instead of quoting both paragraphs", () => {
    const next = clone(base);
    next.guideIntros = { ...next.guideIntros, ethos: "A rewritten ethos introduction." };

    const entries = diffCanon(base, next);
    expect(entries).toHaveLength(1);
    expect(entries[0].section).toBe("ethos");
    expect(entries[0].label).toBe("introduction rewritten");
  });

  it("truncates a long scalar value in the label", () => {
    const next = clone(base);
    next.values[0].cost = "x".repeat(300);

    const entries = diffCanon(base, next);
    expect(entries[0].label.length).toBeLessThan(200);
    expect(entries[0].label).toContain("…");
  });

  it("produces identical output for the same input twice", () => {
    const next = clone(base);
    next.palette[1].hex = "#eeeeee";
    next.values[0].title = "Changed";

    expect(diffCanon(base, next)).toEqual(diffCanon(base, next));
  });
});

describe("renderChangelog", () => {
  it("returns an empty string for no entries", () => {
    expect(renderChangelog([])).toBe("");
  });

  it("groups entries under subtab headings", () => {
    const next = clone(base);
    next.palette[0].hex = "#111111";
    next.values[0].title = "Changed";

    const md = renderChangelog(diffCanon(base, next));

    expect(md).toContain("## Color");
    expect(md).toContain("## Ethos");
  });

  it("is deterministic across repeated calls", () => {
    const next = clone(base);
    next.palette[0].hex = "#111111";
    next.values[0].title = "Changed";
    const entries = diffCanon(base, next);

    expect(renderChangelog(entries)).toBe(renderChangelog(entries));
  });

  it("mentions each changed item by its display name", () => {
    const next = clone(base);
    next.palette[2].hex = "#a51829";

    expect(renderChangelog(diffCanon(base, next))).toContain("Seal Red");
  });
});
