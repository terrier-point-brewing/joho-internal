import type { Capability } from "@/lib/auth/capabilities";
import { CAP } from "@/lib/auth/capabilities";

export type SettingsNavEntry = { href: string; label: string; requires?: Capability };

/**
 * The settings hub, in one place. Every screen that configures something lives
 * here — there are no per-section settings surfaces any more.
 *
 * Two rules this encodes:
 *
 *   * A settings screen is the `manage` face of a domain that already exists,
 *     so each entry gates on that domain rather than on any "settings"
 *     permission. There is deliberately no `settings.*` scope family.
 *   * The hub itself is session-gated only. Every group and subtab gates
 *     independently, so what a user sees here is exactly what they can open.
 *
 * Account and Appearance carry no capability on purpose: your own password is
 * a lockout risk to gate, and your own light/dark choice is a per-browser
 * display preference. The app-wide reskin control inside Appearance is gated
 * separately on org.appearance:manage.
 */
export const SETTINGS_GROUPS: SettingsNavEntry[] = [
  { href: "/settings/account", label: "Account" },
  { href: "/settings/appearance", label: "Appearance" },
  { href: "/settings/business", label: "Business", requires: CAP.businessSettingsManage },
  { href: "/settings/users", label: "Users", requires: CAP.usersManage },
  { href: "/settings/requests", label: "Access Requests", requires: CAP.usersManage },
  { href: "/settings/cron", label: "Cron Jobs", requires: CAP.cronRead },
  { href: "/settings/finance", label: "Finance", requires: CAP.financeTransactionsManage },
  { href: "/settings/payroll", label: "Payroll", requires: CAP.payrollManage },
  // finance.tax is a dot-prefix of finance.tax.filing, so anyone holding
  // taxManage satisfies this by inheritance; a holder of only the filing
  // sub-leaf sees the group with just its Filing subtab.
  { href: "/settings/tax", label: "Tax", requires: CAP.taxFilingManage },
  { href: "/settings/production", label: "Production", requires: CAP.productionSettingsManage },
  { href: "/settings/catalog", label: "Catalog", requires: CAP.catalogRead },
];

export const FINANCE_SETTINGS_NAV: SettingsNavEntry[] = [
  { href: "/settings/finance/chart-of-accounts", label: "Chart of Accounts" },
  { href: "/settings/finance/account-mapping", label: "Account Mapping" },
  { href: "/settings/finance/expense-accounts", label: "Expense Accounts" },
  { href: "/settings/finance/counterparty-accounts", label: "Counterparty Accounts" },
];

export const PAYROLL_SETTINGS_NAV: SettingsNavEntry[] = [
  { href: "/settings/payroll/config", label: "Payroll" },
  { href: "/settings/payroll/departments", label: "Departments" },
];

export const TAX_SETTINGS_NAV: SettingsNavEntry[] = [
  { href: "/settings/tax/profile", label: "Tax Profile", requires: CAP.taxManage },
  { href: "/settings/tax/filing", label: "Tax Filing", requires: CAP.taxFilingManage },
];

export const PRODUCTION_SETTINGS_NAV: SettingsNavEntry[] = [
  { href: "/settings/production/deposits", label: "Deposit Settings" },
  { href: "/settings/production/export", label: "Export Settings" },
];
