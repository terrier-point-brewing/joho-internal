export type Section = "taproom" | "production" | "finance" | "payroll" | "tax" | "brand" | "settings";

/**
 * Twenty leaves across seven prefixes. A scope is split only where two
 * resources genuinely need different read levels; the ladder absorbs
 * everything else. `taproom.settings` has no API routes of its own — it is
 * enforced only by the app/taproom/settings/layout.tsx redirect.
 */
export const SCOPES = {
  "taproom.performance": { label: "Performance", section: "taproom" },
  "taproom.targets": { label: "Targets", section: "taproom" },
  "taproom.settings": { label: "Settings", section: "taproom" },

  "production.brewing": { label: "Brewing", section: "production" },
  "production.inventory": { label: "Inventory", section: "production" },
  "production.export": { label: "Export", section: "production" },
  "production.recipes": { label: "Recipes", section: "production" },
  "production.partners": { label: "Partners", section: "production" },
  "production.equipment": { label: "Equipment", section: "production" },
  "production.settings": { label: "Settings", section: "production" },

  "finance.transactions": { label: "Transactions", section: "finance" },
  "finance.statements": { label: "Statements", section: "finance" },

  payroll: { label: "Payroll", section: "payroll" },

  tax: { label: "Tax", section: "tax" },
  "tax.pii": { label: "PII", section: "tax" },

  "brand.guide": { label: "Guide", section: "brand" },
  "brand.workbench": { label: "Workbench", section: "brand" },

  "settings.business": { label: "Business", section: "settings" },
  "settings.users": { label: "Users", section: "settings" },
  "settings.cron": { label: "Cron", section: "settings" },
} as const satisfies Record<string, { label: string; section: Section }>;

/** Derived from the const, so a typo is a compile error rather than a runtime 403. */
export type ScopeKey = keyof typeof SCOPES;

export const ROOT = "" as const;
