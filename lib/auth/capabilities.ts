import type { Level } from "./levels";
import type { ScopeKey } from "./scopes";

export interface Capability {
  scope: ScopeKey;
  level: Level;
}

/**
 * Named intents, imported by both the route and the component that gates
 * the same action. Several names may share a (scope, level) pair — that is
 * intentional; capabilities name the *intent*, not the coordinate.
 */
export const CAP = {
  brewingOperate: { scope: "production.brewing", level: "operate" },
  brewingRead: { scope: "production.brewing", level: "read" },
  batchDelete: { scope: "production.brewing", level: "admin" },
  brewingCalendarAdmin: { scope: "production.brewing", level: "admin" },

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
  taproomSettingsOperate: { scope: "taproom.settings", level: "operate" },

  taxRead: { scope: "tax", level: "read" },
  taxOperate: { scope: "tax", level: "operate" },
  taxManage: { scope: "tax", level: "manage" },
  taxPiiReveal: { scope: "tax.pii", level: "admin" },

  payrollRead: { scope: "payroll", level: "read" },
  payrollOperate: { scope: "payroll", level: "operate" },
  payrollManage: { scope: "payroll", level: "manage" },

  businessSettingsManage: { scope: "settings.business", level: "manage" },
  usersManage: { scope: "settings.users", level: "manage" },
  cronRead: { scope: "settings.cron", level: "read" },

  brandGuideRead: { scope: "brand.guide", level: "read" },
  brandGuideManage: { scope: "brand.guide", level: "manage" },
  brandWorkbenchRead: { scope: "brand.workbench", level: "read" },
  brandWorkbenchManage: { scope: "brand.workbench", level: "manage" },

  financeStatementsRead: { scope: "finance.statements", level: "read" },
  financeTransactionsRead: { scope: "finance.transactions", level: "read" },
  financeTransactionsManage: { scope: "finance.transactions", level: "manage" },
} as const satisfies Record<string, Capability>;
