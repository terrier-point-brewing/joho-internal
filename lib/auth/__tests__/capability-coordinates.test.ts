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
 * The route-less capabilities (layout-only / UI-only) are marked `// no
 * route` below: brewingCalendarAdmin, brandGuideRead, and the four admission
 * leaves. Their coordinate has no independent route-derived source, so it is
 * taken from lib/auth/capabilities.ts and pinned here deliberately.
 */
const EXPECTED: Record<keyof typeof CAP, { scope: ScopeKey; level: Level }> = {
  // Admission leaves — read, always, and never anything else. A `.access` key
  // pinned above read would silently turn a door into an authority check.
  taproomAccess: { scope: "taproom.access", level: "read" }, // no route
  productionAccess: { scope: "production.access", level: "read" }, // no route
  financeAccess: { scope: "finance.access", level: "read" }, // no route
  brandAccess: { scope: "brand.access", level: "read" }, // no route

  catalogRead: { scope: "catalog", level: "read" },
  catalogOperate: { scope: "catalog", level: "operate" },

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

  taproomPerformanceRead: { scope: "taproom.performance", level: "read" }, // no route
  taproomPerformanceOperate: { scope: "taproom.performance", level: "operate" },
  targetsRead: { scope: "taproom.targets", level: "read" }, // no route
  targetsEdit: { scope: "taproom.targets", level: "manage" },

  taxRead: { scope: "finance.tax", level: "read" },
  taxOperate: { scope: "finance.tax", level: "operate" },
  taxManage: { scope: "finance.tax", level: "manage" },
  taxFilingRead: { scope: "finance.tax.filing", level: "read" },
  taxFilingManage: { scope: "finance.tax.filing", level: "manage" }, // no route
  taxPiiReveal: { scope: "finance.tax.pii", level: "admin" },

  payrollRead: { scope: "payroll", level: "read" },
  payrollOperate: { scope: "payroll", level: "operate" },
  payrollManage: { scope: "payroll", level: "manage" },
  payrollDayOverride: { scope: "payroll", level: "operate" },

  businessSettingsManage: { scope: "org.business", level: "manage" },
  usersManage: { scope: "org.users", level: "manage" },
  cronRead: { scope: "org.jobs", level: "read" },
  appearanceManage: { scope: "org.appearance", level: "manage" },

  brandGuideRead: { scope: "brand.guide", level: "read" }, // no route
  brandGuideManage: { scope: "brand.guide", level: "manage" },
  brandAssetsRead: { scope: "brand.assets", level: "read" },
  brandAssetsManage: { scope: "brand.assets", level: "manage" },
  brandReleasesRead: { scope: "brand.releases", level: "read" },
  brandReleasesManage: { scope: "brand.releases", level: "manage" },
  brandTemplatesRead: { scope: "brand.templates", level: "read" },
  brandTemplatesManage: { scope: "brand.templates", level: "manage" },
  brandOutputsRead: { scope: "brand.outputs", level: "read" },
  brandOutputsOperate: { scope: "brand.outputs", level: "operate" },
  brandOutputsManage: { scope: "brand.outputs", level: "manage" },

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
