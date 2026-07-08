/**
 * Production-inventory expense alerts.
 *
 * Expenses coded to these chart-of-accounts numbers are purchases of production
 * ingredients/packaging, which require a matching production-inventory update. The
 * Expenses tab surfaces un-dismissed ones in a banner. This module is the single
 * source of truth for which accounts trigger the alert — add a third by appending
 * to the array below.
 */

export const PRODUCTION_INVENTORY_ACCOUNT_NUMBERS = ["5110", "5120"] as const;

const ACCOUNT_SET = new Set<string>(PRODUCTION_INVENTORY_ACCOUNT_NUMBERS);

export function isProductionInventoryAccount(
  accountNumber: string | null | undefined,
): boolean {
  return accountNumber != null && ACCOUNT_SET.has(accountNumber.trim());
}

/** Minimal shape the selector needs — a subset of the expenses GET row. */
export interface InventoryAlertExpense {
  id: string;
  inventory_alert_dismissed: boolean;
  accounting_date: string | null;
  chart_of_accounts: { account_number: string | null } | null;
}

/**
 * Un-dismissed expenses coded to a production-inventory account, newest first
 * (by accounting_date; nulls last). Pure — safe to call on every render.
 */
export function selectInventoryAlerts<T extends InventoryAlertExpense>(
  expenses: T[],
): T[] {
  return expenses
    .filter(
      (e) =>
        !e.inventory_alert_dismissed &&
        isProductionInventoryAccount(e.chart_of_accounts?.account_number),
    )
    .sort((a, b) => (b.accounting_date ?? "").localeCompare(a.accounting_date ?? ""));
}
