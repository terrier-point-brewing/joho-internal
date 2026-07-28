import { describe, it, expect } from "vitest";
import { ROLE_BUNDLES } from "./roleGrants";
import { CAP } from "./capabilities";
import { effectiveLevel } from "./resolve";
import { SCOPES, ROOT, type ScopeKey, type Section } from "./scopes";

const SECTIONS: Section[] = ["taproom", "production", "finance", "payroll", "catalog", "brand", "org"];

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

  it("grants admin on all 27 scopes for the admin role", () => {
    const scopeKeys = Object.keys(SCOPES) as ScopeKey[];
    expect(scopeKeys.length).toBe(27);
    for (const scope of scopeKeys) {
      expect(effectiveLevel(ROLE_BUNDLES.admin, scope)).toBe("admin");
    }
  });

  it("gives every non-admin bundle admission to exactly the sections it can use", () => {
    // A section is reachable iff its `.access` leaf resolves at read or better.
    // Leaf-only holders need an explicit row; bare-section holders get it free
    // by prefix. Both paths are exercised here.
    expect(effectiveLevel(ROLE_BUNDLES.viewer, "taproom.access")).toBe("read");
    expect(effectiveLevel(ROLE_BUNDLES.brewer, "taproom.access")).toBe("read");
    expect(effectiveLevel(ROLE_BUNDLES.brewer, "production.access")).toBe("read");
    expect(effectiveLevel(ROLE_BUNDLES.manager, "production.access")).toBe("read");
    // manager holds bare `taproom`, so admission comes by prefix, not a row.
    expect(effectiveLevel(ROLE_BUNDLES.manager, "taproom.access")).toBe("operate");

    for (const role of ["viewer", "brewer", "manager"] as const) {
      expect(effectiveLevel(ROLE_BUNDLES[role], "finance.access")).toBeNull();
      expect(effectiveLevel(ROLE_BUNDLES[role], "brand.access")).toBeNull();
    }
    expect(effectiveLevel(ROLE_BUNDLES.viewer, "production.access")).toBeNull();
  });

  it("has an empty custom bundle", () => {
    expect(ROLE_BUNDLES.custom).toEqual({});
  });

  it("grants manager no access to finance scopes, tax included", () => {
    expect(effectiveLevel(ROLE_BUNDLES.manager, "finance.access")).toBeNull();
    expect(effectiveLevel(ROLE_BUNDLES.manager, "finance.transactions")).toBeNull();
    expect(effectiveLevel(ROLE_BUNDLES.manager, "finance.statements")).toBeNull();
    expect(effectiveLevel(ROLE_BUNDLES.manager, "finance.tax")).toBeNull();
    expect(effectiveLevel(ROLE_BUNDLES.manager, "finance.tax.pii")).toBeNull();
  });

  it("grants manager no manage anywhere, and no catalog", () => {
    // The settings hub shows a subtab only at `manage`, so "manager holds no
    // manage" IS the mechanism that keeps the hub empty for them. Restoring
    // any of it should be a grant edit, not a code change — if this test
    // fails, check that was deliberate.
    for (const level of Object.values(ROLE_BUNDLES.manager)) {
      expect(["read", "operate"]).toContain(level);
    }
    expect(effectiveLevel(ROLE_BUNDLES.manager, "catalog")).toBeNull();
  });

  it("brewer's finance.tax.filing leaf confers nothing else in finance", () => {
    // The sibling-leaf rule is what lets a leaf be granted across a section
    // boundary without widening anyone into that section. Excise rates are the
    // live case: brewer reads them inside Export Settings and gains no finance.
    expect(effectiveLevel(ROLE_BUNDLES.brewer, "finance.tax.filing")).toBe("read");
    expect(effectiveLevel(ROLE_BUNDLES.brewer, "finance.access")).toBeNull();
    expect(effectiveLevel(ROLE_BUNDLES.brewer, "finance.tax")).toBeNull();
    expect(effectiveLevel(ROLE_BUNDLES.brewer, "finance.tax.pii")).toBeNull();
    expect(effectiveLevel(ROLE_BUNDLES.brewer, "finance.statements")).toBeNull();
  });

  it("applies the Targets rule for manager", () => {
    expect(effectiveLevel(ROLE_BUNDLES.manager, "taproom.targets")).toBe("read");
    expect(effectiveLevel(ROLE_BUNDLES.manager, "taproom.performance")).toBe("operate");
  });

  it("never grants the 'none' rung — that's a per-user revoke, not a static bundle concept", () => {
    for (const bundle of Object.values(ROLE_BUNDLES)) {
      for (const level of Object.values(bundle)) {
        expect(level).not.toBe("none");
      }
    }
  });
});

describe("CAP", () => {
  it("every entry's scope exists in SCOPES", () => {
    for (const cap of Object.values(CAP)) {
      expect(cap.scope in SCOPES).toBe(true);
    }
  });
});
