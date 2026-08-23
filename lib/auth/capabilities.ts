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
 *
 * Entry NAMES are a stable API: lib/auth/__fixtures__/legacy-matrix.ts keys
 * 212 rows on them. A scope re-key should change the `scope:` coordinate here
 * and leave the name alone (that is why `taxRead` still reads "tax" while
 * pointing at `finance.tax`).
 */
export const CAP = {
  // ── Admission ────────────────────────────────────────────────────────────
  // Read-gated in each section's layout and used for nothing else. Never gate
  // authority on an access key, and never gate one above `read`.
  taproomAccess: { scope: "taproom.access", level: "read" },
  productionAccess: { scope: "production.access", level: "read" },
  financeAccess: { scope: "finance.access", level: "read" },
  brandAccess: { scope: "brand.access", level: "read" },
  // marketingAccess is the fifth admission key; it lives with the rest of the
  // Marketing block below so that section reads as one unit.

  brewingOperate: { scope: "production.brewing", level: "operate" },
  brewingRead: { scope: "production.brewing", level: "read" },
  batchDelete: { scope: "production.brewing", level: "admin" },
  brewingCalendarAdmin: { scope: "production.brewing", level: "admin" },
  tankReassign: { scope: "production.brewing", level: "admin" },

  ingredientMasterEdit: { scope: "production.inventory", level: "manage" },
  packagingMasterEdit: { scope: "production.inventory", level: "manage" },
  // Creating a single new ingredient/packaging item sits one tier below
  // editing one: an operator adding a hop they just received should not need
  // manage, but changing or deleting an existing row — and the bulk paths,
  // which rewrite many rows at once — still do.
  ingredientMasterCreate: { scope: "production.inventory", level: "operate" },
  packagingMasterCreate: { scope: "production.inventory", level: "operate" },
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

  // Production-only configuration: deposit terms and export settings. The
  // Square-mapping half of this scope moved to `catalog`.
  productionSettingsRead: { scope: "production.settings", level: "read" },
  productionSettingsOperate: { scope: "production.settings", level: "operate" },
  productionSettingsManage: { scope: "production.settings", level: "manage" },

  // Square Item Mappings — one scope for a capability reachable from two
  // sections, so no route ever has to invent a second gate for it.
  catalogRead: { scope: "catalog", level: "read" },
  catalogOperate: { scope: "catalog", level: "operate" },

  taproomPerformanceRead: { scope: "taproom.performance", level: "read" },
  taproomPerformanceOperate: { scope: "taproom.performance", level: "operate" },
  targetsRead: { scope: "taproom.targets", level: "read" },
  targetsEdit: { scope: "taproom.targets", level: "manage" },

  taxRead: { scope: "finance.tax", level: "read" },
  taxOperate: { scope: "finance.tax", level: "operate" },
  taxManage: { scope: "finance.tax", level: "manage" },
  // Filing configuration + the excise rate reference data it owns. A sub-leaf
  // so it can be granted without conferring the rest of finance.tax.
  taxFilingRead: { scope: "finance.tax.filing", level: "read" },
  taxFilingManage: { scope: "finance.tax.filing", level: "manage" },
  taxPiiReveal: { scope: "finance.tax.pii", level: "admin" },

  payrollRead: { scope: "payroll", level: "read" },
  payrollOperate: { scope: "payroll", level: "operate" },
  payrollManage: { scope: "payroll", level: "manage" },
  // Named intent for the Shifts-grid day override. Deliberately shares the
  // `operate` coordinate, which manager and admin already hold — so no
  // ROLE_BUNDLES change, and manager still cannot lock a period or use the
  // Summary-tab period override (both `payrollManage`).
  payrollDayOverride: { scope: "payroll", level: "operate" },

  businessSettingsManage: { scope: "org.business", level: "manage" },
  usersManage: { scope: "org.users", level: "manage" },
  cronRead: { scope: "org.jobs", level: "read" },
  // The "apply brand to the internal app" toggle — app-wide restyling, split
  // out of brandGuideManage, which is only about brand CONTENT.
  appearanceManage: { scope: "org.appearance", level: "manage" },

  brandGuideRead: { scope: "brand.guide", level: "read" },
  brandGuideManage: { scope: "brand.guide", level: "manage" },
  brandAssetsRead: { scope: "brand.assets", level: "read" },
  brandAssetsManage: { scope: "brand.assets", level: "manage" },
  brandReleasesRead: { scope: "brand.releases", level: "read" },
  brandReleasesManage: { scope: "brand.releases", level: "manage" },

  brandTemplatesRead: { scope: "brand.templates", level: "read" },
  brandTemplatesManage: { scope: "brand.templates", level: "manage" },
  brandOutputsRead: { scope: "brand.outputs", level: "read" },
  /** Draft a render. Producing is not approving. */
  brandOutputsOperate: { scope: "brand.outputs", level: "operate" },
  /** Approve and export — the human gate an agent draft must pass through. */
  brandOutputsManage: { scope: "brand.outputs", level: "manage" },

  // ── Marketing ────────────────────────────────────────────────────────────
  /** Section admission. Read-gated in app/marketing/layout.tsx and nowhere else. */
  marketingAccess: { scope: "marketing.access", level: "read" },
  /**
   * Connecting, viewing and disconnecting a channel login. `manage` from the
   * start: the Accounts screen exists to hold credentials, and there is no
   * meaningful read-only face of "here are the tokens".
   */
  marketingAccountsManage: { scope: "marketing.accounts", level: "manage" },
  /** Reading the calendar — the month, an entry, its media and its deliveries. */
  marketingCalendarRead: { scope: "marketing.calendar", level: "read" },
  /**
   * Writing an entry, its ordered media and (when a person posts now) its
   * deliveries. `operate` rather than `manage`: putting something on the
   * calendar is the day job. Note this is deliberately NOT the authority that
   * publishes — the worker's human-retry path is `marketing.publish`, and
   * "post now" is the one place the two meet, which is why that path is a
   * person pressing a button and never a default.
   */
  marketingCalendarEdit: { scope: "marketing.calendar", level: "operate" },
  /**
   * Putting a delivery out through a channel, and putting a failed one back on
   * the queue. `operate` rather than `manage`: publishing what a person already
   * approved is the day job, not an administrative act.
   */
  marketingPublish: { scope: "marketing.publish", level: "operate" },

  financeStatementsRead: { scope: "finance.statements", level: "read" },
  financeTransactionsRead: { scope: "finance.transactions", level: "read" },
  financeTransactionsManage: { scope: "finance.transactions", level: "manage" },
} as const satisfies Record<string, Capability>;
