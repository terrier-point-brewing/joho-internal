import { describe, it, expect } from "vitest";
import { effectiveLevel, can, type ScopeGrants } from "./resolve";
import type { ScopeKey } from "./scopes";

describe("effectiveLevel", () => {
  it("matches an exact key", () => {
    const grants: ScopeGrants = { "finance.statements": "read" };
    expect(effectiveLevel(grants, "finance.statements")).toBe("read");
  });

  it("cascades a section grant to its leaves", () => {
    const grants: ScopeGrants = { finance: "read" };
    expect(effectiveLevel(grants, "finance.statements")).toBe("read");
  });

  it("lets a longer key override a shorter one", () => {
    const grants: ScopeGrants = { finance: "admin", "finance.statements": "read" };
    expect(effectiveLevel(grants, "finance.statements")).toBe("read");
    expect(effectiveLevel(grants, "finance.transactions")).toBe("admin");
  });

  it("ROOT matches every scope", () => {
    const grants: ScopeGrants = { "": "admin" };
    const scopes: ScopeKey[] = ["finance.statements", "production.brewing", "finance.tax.pii"];
    for (const scope of scopes) {
      expect(effectiveLevel(grants, scope)).toBe("admin");
    }
  });

  it("ROOT loses to any more specific key", () => {
    const grants: ScopeGrants = { "": "read", "finance.tax.pii": "admin" };
    expect(effectiveLevel(grants, "finance.tax.pii")).toBe("admin");
  });

  it("returns null with no matching grant", () => {
    const grants: ScopeGrants = {};
    expect(effectiveLevel(grants, "finance.statements")).toBeNull();
    expect(can(grants, "finance.statements", "read")).toBe(false);
  });

  it("the ladder is inclusive: a higher grant satisfies a lower requirement", () => {
    const grants: ScopeGrants = { "finance.statements": "manage" };
    expect(can(grants, "finance.statements", "read")).toBe(true);
    expect(can(grants, "finance.statements", "operate")).toBe(true);
  });

  it("the ladder is not reversible: a lower grant does not satisfy a higher requirement", () => {
    const grants: ScopeGrants = { "finance.statements": "operate" };
    expect(can(grants, "finance.statements", "manage")).toBe(false);
  });

  it("prefix matching is dot-delimited, not a bare substring match", () => {
    const grants: ScopeGrants = { catalog: "admin" };
    // "catalogs.foo" is not a real ScopeKey, but the matcher must not treat
    // "catalog" as a substring prefix of it — cast to exercise the guard.
    expect(effectiveLevel(grants, "catalogs.foo" as ScopeKey)).toBeNull();
  });
});

describe("the 'none' rung — an explicit revoke", () => {
  it("a leaf 'none' beats an ancestor section grant", () => {
    const grants: ScopeGrants = { finance: "read", "finance.statements": "none" };
    expect(effectiveLevel(grants, "finance.statements")).toBe("none");
    expect(can(grants, "finance.statements", "read")).toBe(false);
    // The section grant still applies to a sibling leaf.
    expect(can(grants, "finance.transactions", "read")).toBe(true);
  });

  it("'none' at the root denies everything", () => {
    const grants: ScopeGrants = { "": "none" };
    expect(can(grants, "finance.statements", "read")).toBe(false);
    expect(can(grants, "finance.tax.pii", "read")).toBe(false);
  });

  it("'none' is distinguishable from no grant at all", () => {
    const explicitlyRevoked: ScopeGrants = { "finance.statements": "none" };
    const noGrant: ScopeGrants = {};
    expect(effectiveLevel(explicitlyRevoked, "finance.statements")).toBe("none");
    expect(effectiveLevel(noGrant, "finance.statements")).toBeNull();
    // Both fail `can`, but effectiveLevel keeps them distinct for callers
    // (e.g. the grants admin UI) that need to render "revoked" differently
    // from "inherits nothing".
    expect(can(explicitlyRevoked, "finance.statements", "read")).toBe(false);
    expect(can(noGrant, "finance.statements", "read")).toBe(false);
  });
});
