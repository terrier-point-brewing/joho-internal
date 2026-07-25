import { describe, it, expect } from "vitest";
import { ROLE_BUNDLES } from "./roleGrants";
import { CAP } from "./capabilities";
import { effectiveLevel } from "./resolve";
import { SCOPES, ROOT, type ScopeKey, type Section } from "./scopes";

const SECTIONS: Section[] = ["taproom", "production", "finance", "payroll", "tax", "brand", "settings"];

function isValidKey(key: string): boolean {
  return key === ROOT || key in SCOPES || (SECTIONS as string[]).includes(key);
}

describe("ROLE_BUNDLES", () => {
  it("only uses keys that are valid scopes, sections, or ROOT", () => {
    for (const bundle of Object.values(ROLE_BUNDLES)) {
      for (const key of Object.keys(bundle)) {
        expect(isValidKey(key)).toBe(true);
      }
    }
  });

  it("grants admin on all 20 scopes for the admin role", () => {
    const scopeKeys = Object.keys(SCOPES) as ScopeKey[];
    expect(scopeKeys.length).toBe(20);
    for (const scope of scopeKeys) {
      expect(effectiveLevel(ROLE_BUNDLES.admin, scope)).toBe("admin");
    }
  });

  it("has an empty custom bundle", () => {
    expect(ROLE_BUNDLES.custom).toEqual({});
  });

  it("grants manager no access to finance scopes", () => {
    expect(effectiveLevel(ROLE_BUNDLES.manager, "finance.transactions")).toBeNull();
    expect(effectiveLevel(ROLE_BUNDLES.manager, "finance.statements")).toBeNull();
  });

  it("applies the Targets rule for manager", () => {
    expect(effectiveLevel(ROLE_BUNDLES.manager, "taproom.targets")).toBe("read");
    expect(effectiveLevel(ROLE_BUNDLES.manager, "taproom.performance")).toBe("operate");
  });
});

describe("CAP", () => {
  it("every entry's scope exists in SCOPES", () => {
    for (const cap of Object.values(CAP)) {
      expect(cap.scope in SCOPES).toBe(true);
    }
  });
});
