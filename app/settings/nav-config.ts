import type { Capability } from "@/lib/auth/capabilities";
import { CAP } from "@/lib/auth/capabilities";

export type SettingsNavEntry = {
  href: string;
  label: string;
  requires?: Capability;
  requiresAny?: Capability[];
};

/**
 * The settings hub, in one place. Every screen that configures something lives
 * here — there are no per-section settings surfaces any more.
 *
 * Three rules this encodes:
 *
 *   * A settings screen is the `manage` face of a domain that already exists,
 *     so each entry gates on that domain rather than on any "settings"
 *     permission. There is deliberately no `settings.*` scope family.
 *   * The hub itself is session-gated only. Every group and subtab gates
 *     independently, so what a user sees here is exactly what they can open.
 *   * Groups follow the scope families, one group per family — `org.*` is
 *     Environment, `finance.tax*` is Tax, and so on. The scope-less screens
 *     (your own password, your own theme) collect under User. That is why the
 *     group list reads the way the permission registry does.
 *
 * These groups render in the app sidebar, like every other section's nav, plus
 * a `md:hidden` row inside each group layout for mobile. They are NOT a tab row
 * above the sub-tabs — settings is one level of subtabs deep, same as the rest
 * of the app.
 */
export const SETTINGS_GROUPS: SettingsNavEntry[] = [
  { href: "/settings/user", label: "User" },
  {
    href: "/settings/environment",
    label: "Environment",
    // The four org.* screens need three unrelated scopes, so no single
    // capability covers the group — show it when any child is reachable and
    // let each subtab gate itself.
    requiresAny: [CAP.businessSettingsManage, CAP.usersManage, CAP.cronRead],
  },
  { href: "/settings/finance", label: "Finance", requires: CAP.financeTransactionsManage },
  { href: "/settings/payroll", label: "Payroll", requires: CAP.payrollManage },
  // finance.tax is a dot-prefix of finance.tax.filing, so anyone holding
  // taxManage satisfies this by inheritance; a holder of only the filing
  // sub-leaf sees the group with just its Filing subtab.
  { href: "/settings/tax", label: "Tax", requires: CAP.taxFilingManage },
  { href: "/settings/production", label: "Production", requires: CAP.productionSettingsManage },
  { href: "/settings/catalog", label: "Catalog", requires: CAP.catalogRead },
];

/**
 * Account and Appearance carry no capability on purpose: your own password is
 * a lockout risk to gate, and your own light/dark choice is a per-browser
 * display preference. The app-wide reskin control inside Appearance is gated
 * separately on org.appearance:manage.
 */
export const USER_SETTINGS_NAV: SettingsNavEntry[] = [
  { href: "/settings/user/account", label: "Account" },
  { href: "/settings/user/appearance", label: "Appearance" },
];

export const ENVIRONMENT_SETTINGS_NAV: SettingsNavEntry[] = [
  { href: "/settings/environment/business", label: "Business", requires: CAP.businessSettingsManage },
  { href: "/settings/environment/users", label: "Users", requires: CAP.usersManage },
  { href: "/settings/environment/requests", label: "Access Requests", requires: CAP.usersManage },
  { href: "/settings/environment/cron", label: "Cron Jobs", requires: CAP.cronRead },
];

export const FINANCE_SETTINGS_NAV: SettingsNavEntry[] = [
  { href: "/settings/finance/chart-of-accounts", label: "Chart of Accounts" },
  { href: "/settings/finance/account-mapping", label: "Account Mapping" },
  { href: "/settings/finance/expense-accounts", label: "Expense Accounts" },
  { href: "/settings/finance/counterparty-accounts", label: "Counterparty Accounts" },
  { href: "/settings/finance/sales-tax-accounts", label: "Sales Tax Accounts" },
  { href: "/settings/finance/balance-sheet-accounts", label: "Balance Sheet Accounts" },
  // Ramp's balance setup flow. Plaid and Square each need their own, since
  // running Plaid Link and capturing a Square anchor share nothing with picking
  // a Ramp account — expect siblings here, and a consolidation once all three
  // exist and their shape is known rather than guessed at.
  { href: "/settings/finance/ramp-connection", label: "Ramp Connection" },
  { href: "/settings/finance/square-connection", label: "Square Connection" },
  { href: "/settings/finance/backfill", label: "Backfill" },
];

export const PAYROLL_SETTINGS_NAV: SettingsNavEntry[] = [
  { href: "/settings/payroll/config", label: "Payroll" },
  { href: "/settings/payroll/departments", label: "Departments" },
  { href: "/settings/payroll/backfill", label: "Backfill" },
];

export const TAX_SETTINGS_NAV: SettingsNavEntry[] = [
  { href: "/settings/tax/profile", label: "Tax Profile", requires: CAP.taxManage },
  { href: "/settings/tax/filing", label: "Tax Filing", requires: CAP.taxFilingManage },
  // The group gates on taxFilingManage, but this backfill's route enforces
  // finance.tax:manage — the PARENT scope. Without an explicit gate a holder of
  // only the filing sub-leaf would see a tab that 401s.
  { href: "/settings/tax/backfill", label: "Backfill", requires: CAP.taxManage },
];

export const PRODUCTION_SETTINGS_NAV: SettingsNavEntry[] = [
  { href: "/settings/production/deposits", label: "Deposit Settings" },
  { href: "/settings/production/export", label: "Export Settings" },
  // The group gates on production.settings:manage, but this backfill's route
  // enforces production.export:manage — a different scope, not a parent — so it
  // needs its own gate or a settings-only holder sees a tab that 403s.
  { href: "/settings/production/backfill", label: "Backfill", requires: CAP.exportManage },
];
