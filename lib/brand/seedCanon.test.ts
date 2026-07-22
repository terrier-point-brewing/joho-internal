import { describe, expect, it } from "vitest";
import { seedCanon } from "./seedCanon";
import type { FontRole, RoleName } from "./canon.types";

const ROLE_NAMES: RoleName[] = [
  "canvas",
  "surface",
  "surface-raised",
  "primary",
  "on-primary",
  "secondary",
  "accent",
  "on-accent",
  "high-contrast",
  "content",
  "content-muted",
  "line",
  "line-strong",
];

const FONT_ROLES: FontRole[] = ["display", "body", "wordmark", "script"];

describe("seedCanon", () => {
  it("has an entry in roleMap.light for every RoleName", () => {
    for (const role of ROLE_NAMES) {
      expect(seedCanon.roleMap.light[role]).toBeTruthy();
    }
  });

  it("every roleMap.light value is either a palette key or a #hex", () => {
    const keys = new Set(seedCanon.palette.map((c) => c.key));
    for (const role of ROLE_NAMES) {
      const value = seedCanon.roleMap.light[role];
      const isHex = /^#[0-9a-fA-F]{6}$/.test(value);
      const isKey = keys.has(value);
      expect(isHex || isKey).toBe(true);
    }
  });

  it("has exactly one fonts[] entry per FontRole", () => {
    for (const role of FONT_ROLES) {
      const matches = seedCanon.fonts.filter((f) => f.role === role);
      expect(matches.length).toBe(1);
    }
  });

  it("has non-empty mission and voice.summary", () => {
    expect(seedCanon.mission.length).toBeGreaterThan(0);
    expect(seedCanon.voice.summary.length).toBeGreaterThan(0);
  });

  it("has the 10 brand hard rules", () => {
    expect(seedCanon.hardRules.length).toBe(10);
  });

  it("has exactly 5 naming criteria", () => {
    expect(seedCanon.naming.criteria.length).toBe(5);
  });

  it("carries the ethos sections (values, never list, voice rewrites, chop, chassis, illustration)", () => {
    expect(seedCanon.values.length).toBeGreaterThanOrEqual(1);
    expect(seedCanon.neverList.length).toBeGreaterThanOrEqual(1);
    expect(seedCanon.voice.rewrites.length).toBeGreaterThanOrEqual(1);
    expect(seedCanon.chop.specs.length).toBeGreaterThanOrEqual(1);
    expect(seedCanon.labelChassis.elements.length).toBeGreaterThanOrEqual(1);
    expect(seedCanon.illustrationLaw.rules.length).toBeGreaterThanOrEqual(1);
    expect(seedCanon.colorForbidden.length).toBeGreaterThanOrEqual(1);
  });

  it("has a visibility flag for every section", () => {
    const keys = Object.keys(seedCanon.visibility);
    expect(keys.length).toBeGreaterThanOrEqual(12);
    for (const v of Object.values(seedCanon.visibility)) {
      expect(v === "internal" || v === "public").toBe(true);
    }
  });

  it("parses against the canon schema", async () => {
    const { canonSchema } = await import("./canon.schema");
    expect(() => canonSchema.parse(seedCanon)).not.toThrow();
  });
});
