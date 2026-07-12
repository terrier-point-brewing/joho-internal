// Shared account_type → statement_section mapping for the chart of accounts.
// Single source of truth for QBO's 14 standard account types. Consumed by
// both server route handlers (app/api/finance/statements/route.ts) and a
// client component (app/finance/settings/chart-of-accounts/page.tsx), so
// this module must stay free of server-only imports — plain exports only.

export type StatementSection =
  | "revenue"
  | "cogs"
  | "expenses"
  | "other_income"
  | "other_expense"
  | "bank"
  | "ar"
  | "other_current_assets"
  | "fixed_assets"
  | "ap"
  | "credit_card"
  | "other_current_liabilities"
  | "long_term_liabilities"
  | "equity";

export const ACCOUNT_TYPE_SECTION: Record<string, StatementSection> = {
  "Income":                      "revenue",
  "Other Income":                "other_income",
  "Cost of Goods Sold":          "cogs",
  "Expenses":                    "expenses",
  "Other Expense":               "other_expense",
  "Bank":                        "bank",
  "Accounts receivable (A/R)":   "ar",
  "Other Current Assets":        "other_current_assets",
  "Fixed Assets":                "fixed_assets",
  "Accounts payable (A/P)":      "ap",
  "Credit Card":                 "credit_card",
  "Other Current Liabilities":   "other_current_liabilities",
  "Long Term Liabilities":       "long_term_liabilities",
  "Equity":                      "equity",
};
