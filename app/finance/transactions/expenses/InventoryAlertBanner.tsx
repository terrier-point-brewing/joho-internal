"use client";
import { useState } from "react";
import Banner from "@/app/components/ui/Banner";
import { formatCurrencyCents } from "@/lib/format";
import { PRODUCTION_INVENTORY_ACCOUNT_NUMBERS } from "@/lib/finance/inventoryAlerts";

export interface InventoryAlertRow {
  id: string;
  accounting_date: string | null;
  merchant_name: string | null;
  amount_cents: number;
  chart_of_accounts: { account_name: string; account_number: string | null } | null;
}

/**
 * Alerts on expenses coded to production-inventory accounts (5110/5120) that still
 * need a matching inventory update. Each row has a Dismiss checkbox; dismissing every
 * row hides the banner. Renders nothing when there is nothing to flag.
 */
export default function InventoryAlertBanner({
  expenses,
  onDismiss,
}: {
  expenses: InventoryAlertRow[];
  onDismiss: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (expenses.length === 0) return null;
  const n = expenses.length;
  // Widen to number — the constant is a fixed-length `as const` tuple, so a literal
  // `.length === 1` would be a type error, but the count is conceptually dynamic.
  const accountCount: number = PRODUCTION_INVENTORY_ACCOUNT_NUMBERS.length;

  return (
    <Banner tone="info" className="mx-4 sm:mx-6 my-2">
      <div className="flex items-start justify-between gap-3">
        <div>
          <span className="font-semibold">{n}</span> expense{n === 1 ? "" : "s"} on account
          {accountCount === 1 ? "" : "s"}{" "}
          {PRODUCTION_INVENTORY_ACCOUNT_NUMBERS.join(" / ")} need a production inventory update.
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => expenses.forEach((e) => onDismiss(e.id))}
            className="px-2 py-1 text-xs rounded border border-info-border hover:bg-info-surface/40 transition-colors"
          >
            Dismiss all
          </button>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="px-2 py-1 text-xs rounded border border-info-border hover:bg-info-surface/40 transition-colors"
          >
            {open ? "Hide" : "Details"}
          </button>
        </div>
      </div>

      {open && (
        <div className="mt-3 border-t border-info-border/50 pt-2 overflow-x-auto">
          <table className="w-full text-xs text-body">
            <thead>
              <tr className="text-muted text-left">
                <th className="py-1 pr-3 font-medium w-8" scope="col"><span className="sr-only">Dismiss</span></th>
                <th className="py-1 pr-3 font-medium" scope="col">Date</th>
                <th className="py-1 pr-3 font-medium" scope="col">Merchant</th>
                <th className="py-1 pr-3 font-medium" scope="col">Account</th>
                <th className="py-1 pl-3 font-medium text-right" scope="col">Amount</th>
              </tr>
            </thead>
            <tbody>
              {expenses.map((e) => (
                <tr key={e.id} className="border-t border-info-border/30">
                  <td className="py-1 pr-3">
                    <input
                      type="checkbox"
                      aria-label={`Dismiss inventory alert for ${e.merchant_name ?? "expense"}`}
                      onChange={() => onDismiss(e.id)}
                    />
                  </td>
                  <td className="py-1 pr-3 whitespace-nowrap text-muted">{e.accounting_date ?? "—"}</td>
                  <td className="py-1 pr-3 max-w-[280px] truncate">{e.merchant_name ?? "—"}</td>
                  <td className="py-1 pr-3 text-muted whitespace-nowrap">
                    {e.chart_of_accounts?.account_number ?? "—"}
                    {e.chart_of_accounts?.account_name ? ` · ${e.chart_of_accounts.account_name}` : ""}
                  </td>
                  <td className="py-1 pl-3 text-right tabular-nums">{formatCurrencyCents(e.amount_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Banner>
  );
}
