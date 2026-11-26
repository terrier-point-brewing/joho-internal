/**
 * Prepaid expenses — the part of a spread bill the P&L has not recognised yet.
 *
 * ── Derived, never posted ────────────────────────────────────────────────────
 * A bill tagged with the months it covers (expense_service_periods) reaches the
 * P&L an equal share per month. Until a month arrives, its share is something
 * the business has been billed for and not yet used up: a prepaid expense.
 * Nothing writes those monthly movements anywhere. This provider asks the SAME
 * function the P&L spreads the bill with (lib/finance/servicePeriod.ts) what is
 * still to come after period end, so the asset here and the expense retained
 * earnings has absorbed always add up to the bill — the two cannot drift.
 *
 * The other side is whatever the bill already moved on its own date: Accounts
 * Payable while it is open, the bank or card once it is paid. This step only
 * holds back the expense those postings would otherwise have fully charged.
 *
 * Deterministic from recorded history (a bill is only counted from its own
 * date, and nothing is recognised before it), so it is safe to snapshot for
 * any month — no dependsOnCurrentState.
 *
 * ── One account ──────────────────────────────────────────────────────────────
 * Every spread bill defers to whichever account uses the Prepaid expenses
 * method. It is meant for exactly one (GL 1300); selecting it on two would show
 * the same prepaid twice.
 *
 * ── Null vs zero ─────────────────────────────────────────────────────────────
 * No spread bill dated by period end → null, so the step contributes nothing
 * and the account reads from its postings alone. Spread bills that are all
 * fully recognised → 0, which is true.
 */
import { fetchCoa } from "@/lib/finance/financials/fetchSources";
import { coaSection } from "@/lib/finance/financials/aggregateRows";
import { fetchSpreadExpenses } from "@/lib/finance/servicePeriod.server";
import { deferredAfter, isSpreadableSection } from "@/lib/finance/servicePeriod";
import { registerProvider } from "../registry";
import type { BalanceContext, BalanceProvider } from "../registry";

export const prepaidServicePeriods: BalanceProvider = {
  key: "prepaidServicePeriods",
  label: "Bills paid ahead",
  kind: "derived",
  async compute(ctx: BalanceContext): Promise<number | null> {
    const [coa, bills] = await Promise.all([fetchCoa(ctx.supabase), fetchSpreadExpenses(ctx.supabase, ctx.periodEnd)]);
    if (bills.length === 0) return null;

    const coaMap = new Map(coa.map((c) => [c.id, c]));
    const throughMonth = ctx.periodEnd.slice(0, 7);
    let deferred = 0;
    for (const bill of bills) {
      const billMonth = bill.accountingDate.slice(0, 7);
      for (const line of bill.lines) {
        // Mirrors aggregateRows: only income-statement lines are spread.
        if (!isSpreadableSection(coaSection(line.chartOfAccountsId ? coaMap.get(line.chartOfAccountsId) : undefined))) continue;
        deferred += deferredAfter(line.amountCents, bill.period, billMonth, throughMonth);
      }
    }
    // A bill is an outflow (negative); what is left of it is an asset
    // (positive in the internal convention). `0 -` rather than unary minus so
    // a fully recognised set of bills reads 0, not -0.
    return 0 - deferred;
  },
};

registerProvider(prepaidServicePeriods);
