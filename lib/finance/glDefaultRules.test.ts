import { describe, it, expect } from "vitest";
import { resolveGlDefaultPatch, type GlDefaultRule, type VariationScope } from "./glDefaultRules";

function rule(partial: Partial<GlDefaultRule> & Pick<GlDefaultRule, "scope" | "scope_key">): GlDefaultRule {
  return {
    chart_of_accounts_id: null,
    chart_of_accounts_id_pos: null,
    chart_of_accounts_id_invoice: null,
    excluded: null,
    ...partial,
  };
}

const scope: VariationScope = {
  square_variation_id: "VAR",
  catalog_item_id: "item-uuid",
  category_id: "cat-1",
  parent_group_id: "parent-1",
};

describe("resolveGlDefaultPatch", () => {
  it("returns nothing when no rule matches", () => {
    expect(resolveGlDefaultPatch([rule({ scope: "category", scope_key: "other" })], scope)).toEqual({});
  });

  it("applies a parent rule to a variation under it", () => {
    const rules = [rule({ scope: "parent", scope_key: "parent-1", chart_of_accounts_id: "coa-a" })];
    expect(resolveGlDefaultPatch(rules, scope)).toEqual({ chart_of_accounts_id: "coa-a" });
  });

  it("prefers the narrowest scope: item over category over parent", () => {
    const rules = [
      rule({ scope: "parent",   scope_key: "parent-1",  chart_of_accounts_id: "coa-parent" }),
      rule({ scope: "category", scope_key: "cat-1",     chart_of_accounts_id: "coa-cat" }),
      rule({ scope: "item",     scope_key: "item-uuid", chart_of_accounts_id: "coa-item" }),
    ];
    expect(resolveGlDefaultPatch(rules, scope).chart_of_accounts_id).toBe("coa-item");
    expect(resolveGlDefaultPatch(rules.slice(0, 2), scope).chart_of_accounts_id).toBe("coa-cat");
  });

  it("resolves each field independently, so a narrow POS override keeps the broad default", () => {
    const rules = [
      rule({ scope: "category", scope_key: "cat-1",     chart_of_accounts_id: "coa-cat" }),
      rule({ scope: "item",     scope_key: "item-uuid", chart_of_accounts_id_pos: "coa-pos" }),
    ];
    expect(resolveGlDefaultPatch(rules, scope)).toEqual({
      chart_of_accounts_id: "coa-cat",
      chart_of_accounts_id_pos: "coa-pos",
    });
  });

  it("treats a null scope_key as the Uncategorized group, not a wildcard", () => {
    const rules = [rule({ scope: "category", scope_key: null, chart_of_accounts_id: "coa-uncat" })];
    expect(resolveGlDefaultPatch(rules, scope)).toEqual({});
    expect(
      resolveGlDefaultPatch(rules, { ...scope, category_id: null }).chart_of_accounts_id,
    ).toBe("coa-uncat");
  });

  it("carries an exclusion, but never writes excluded: false", () => {
    expect(
      resolveGlDefaultPatch([rule({ scope: "parent", scope_key: "parent-1", excluded: true })], scope),
    ).toEqual({ excluded: true });
    expect(
      resolveGlDefaultPatch([rule({ scope: "parent", scope_key: "parent-1", excluded: false })], scope),
    ).toEqual({});
  });

  it("holds a mapping and an exclusion for the same scope in one rule", () => {
    const rules = [rule({ scope: "category", scope_key: "cat-1", chart_of_accounts_id: "coa-a", excluded: true })];
    expect(resolveGlDefaultPatch(rules, scope)).toEqual({ chart_of_accounts_id: "coa-a", excluded: true });
  });
});
