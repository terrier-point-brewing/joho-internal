import { describe, it, expect } from "vitest";
import { CAP } from "../capabilities";
import type { ScopeKey } from "../scopes";
import type { Level } from "../levels";

/**
 * Pins every CAP entry's exact (scope, level) coordinate.
 *
 * The equivalence test (equivalence.test.ts) only exercises the four legacy
 * role bundles, so a wrong (scope, level) on a capability is invisible
 * whenever it happens to produce the same answer for all four bundles — a
 * sweep found 31/37 levels and 35/37 scopes freely mutable with that suite
 * still green, including downgrading taxPiiReveal from admin to manage. This
 * test has no such blind spot: it checks the literal coordinate, not a
 * derived boolean.
 *
 * For the 34 capabilities backing at least one route, EXPECTED is derived
 * by cross-referencing lib/auth/__fixtures__/legacy-matrix.ts (route ->
 * capability) against the Appendix — route -> (scope, level) table — in
 * docs/superpowers/specs/2026-07-25-scoped-permissions-design.md. Every
 * capability's routes agreed on a single (scope, level) pair; that pair is
 * what's committed below.
 *
 * The remaining 3 capabilities have no API route (layout-only /
 * UI-only): brewingCalendarAdmin, taproomSettingsOperate, brandGuideRead.
 * Their coordinate is taken from lib/auth/capabilities.ts as of this test's
 * authorship — there is no independent route-derived source for them.
 */
const EXPECTED: Record<keyof typeof CAP, { scope: ScopeKey; level: Level }> = {
  brewingOperate: { scope: "production.brewing", level: "operate" },
  brewingRead: { scope: "production.brewing", level: "read" },
  batchDelete: { scope: "production.brewing", level: "admin" },
  brewingCalendarAdmin: { scope: "production.brewing", level: "admin" }, // no route
  tankReassign: { scope: "production.brewing", level: "admin" },

  ingredientMasterEdit: { scope: "production.inventory", level: "manage" },
  packagingMasterEdit: { scope: "production.inventory", level: "manage" },
  safetyStockManage: { scope: "production.inventory", level: "manage" },
  inventoryOperate: { scope: "production.inventory", level: "operate" },

  equipmentManage: { scope: "production.equipment", level: "manage" },

  exportRead: { scope: "production.export", level: "read" },
  exportOperate: { scope: "production.export", level: "operate" },
  exportManage: { scope: "production.export", level: "manage" },

  partnersRead: { scope: "production.partners", level: "read" },
  partnersOperate: { scope: "production.partners", level: "operate" },
  partnersManage: { scope: "production.partners", level: "manage" },

  recipesOperate: { scope: "production.recipes", level: "operate" },

  productionSettingsRead: { scope: "production.settings", level: "read" },
  productionSettingsOperate: { scope: "production.settings", level: "operate" },
  productionSettingsManage: { scope: "production.settings", level: "manage" },

  taproomPerformanceOperate: { scope: "taproom.performance", level: "operate" },
  targetsEdit: { scope: "taproom.targets", level: "manage" },
  taproomSettingsOperate: { scope: "taproom.settings", level: "operate" }, // no route

  taxRead: { scope: "tax", level: "read" },
  taxOperate: { scope: "tax", level: "operate" },
  taxManage: { scope: "tax", level: "manage" },
  taxPiiReveal: { scope: "tax.pii", level: "admin" },

  payrollRead: { scope: "payroll", level: "read" },
  payrollOperate: { scope: "payroll", level: "operate" },
  payrollManage: { scope: "payroll", level: "manage" },
  payrollDayOverride: { scope: "payroll", level: "operate" },

  businessSettingsManage: { scope: "settings.business", level: "manage" },
  usersManage: { scope: "settings.users", level: "manage" },
  cronRead: { scope: "settings.cron", level: "read" },

  brandGuideRead: { scope: "brand.guide", level: "read" }, // no route
  brandGuideManage: { scope: "brand.guide", level: "manage" },
  brandWorkbenchRead: { scope: "brand.workbench", level: "read" },
  brandWorkbenchManage: { scope: "brand.workbench", level: "manage" },

  financeStatementsRead: { scope: "finance.statements", level: "read" },
  financeTransactionsRead: { scope: "finance.transactions", level: "read" },
  financeTransactionsManage: { scope: "finance.transactions", level: "manage" },
};

describe("CAP coordinates are pinned", () => {
  it("EXPECTED covers every CAP key, and only CAP keys", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(Object.keys(CAP).sort());
  });

  it.each(Object.keys(CAP) as (keyof typeof CAP)[])("CAP.%s matches its committed (scope, level)", (name) => {
    expect(CAP[name]).toEqual(EXPECTED[name]);
  });
});
