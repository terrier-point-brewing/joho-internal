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
  batchDelete: { scope: "production.brewing", level: "admin" },

  ingredientMasterEdit: { scope: "production.inventory", level: "manage" },
  packagingMasterEdit: { scope: "production.inventory", level: "manage" },

  targetsEdit: { scope: "taproom.targets", level: "manage" },

  taxPiiReveal: { scope: "tax.pii", level: "admin" },

  usersManage: { scope: "settings.users", level: "manage" },

  brandGuideRead: { scope: "brand.guide", level: "read" },
  brandGuideManage: { scope: "brand.guide", level: "manage" },

  financeStatementsRead: { scope: "finance.statements", level: "read" },
  financeTransactionsManage: { scope: "finance.transactions", level: "manage" },
} as const satisfies Record<string, Capability>;
