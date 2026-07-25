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
    const scopes: ScopeKey[] = ["finance.statements", "production.brewing", "tax.pii"];
    for (const scope of scopes) {
      expect(effectiveLevel(grants, scope)).toBe("admin");
    }
  });

  it("ROOT loses to any more specific key", () => {
    const grants: ScopeGrants = { "": "read", "tax.pii": "admin" };
    expect(effectiveLevel(grants, "tax.pii")).toBe("admin");
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
    const grants: ScopeGrants = { tax: "admin" };
    // "taxes.foo" is not a real ScopeKey, but the matcher must not treat
    // "tax" as a substring prefix of it — cast to exercise the guard.
    expect(effectiveLevel(grants, "taxes.foo" as ScopeKey)).toBeNull();
  });
});
