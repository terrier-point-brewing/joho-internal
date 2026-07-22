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

  it("has at least one agentRule", () => {
    expect(seedCanon.agentRules.length).toBeGreaterThanOrEqual(1);
  });

  it("has exactly 5 naming criteria", () => {
    expect(seedCanon.naming.criteria.length).toBe(5);
  });
});
