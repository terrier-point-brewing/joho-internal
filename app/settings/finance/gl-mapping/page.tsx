"use client";
/**
 * GL Mapping — the one place an external thing is given a chart-of-accounts
 * code.
 *
 * This was four sibling sub-tabs (Account Mapping, Expense Accounts,
 * Counterparty Accounts, Sales Tax Accounts). They were four names for one
 * verb, and "Account Mapping" never said that it meant REVENUE specifically,
 * so an operator looking for "where do I code a Ramp charge" had three
 * plausible tabs to guess between. They are now panels under one tab,
 * ordered by the statement they feed: revenue, then the two expense feeds,
 * then the balance-sheet one.
 *
 * Bank Feeds sits next to Counterparties because the two govern the same bank
 * transactions at two levels — a whole account, or one payee within it — and an
 * operator switching a feed on almost always goes straight to its counterparties
 * next. It is not itself a mapping of a thing to an account, which is why it
 * does not come first.
 *
 * The tabs are an inner TabBar rather than a third nav level — the same thing
 * Chart of Accounts does for its Statement/By Type toggle. docs/UI_STANDARD.md
 * §4 caps settings at one level of sub-tabs.
 *
 * `?tab=` is read once on mount so the Financials data-quality panel can deep
 * link to a specific panel (see HREFS in lib/finance/financials/statementCommon.ts).
 * Following the Financials precedent, the param is not written back on switch.
 *
 * Gated on CAP.financeTransactionsManage by app/settings/finance/layout.tsx,
 * same as every sibling here. Each underlying route enforces it independently.
 */
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import TabBar, { type TabDef } from "@/app/components/TabBar";
import RevenuePanel from "./RevenuePanel";
import ExpensesPanel from "./ExpensesPanel";
import CounterpartiesPanel from "./CounterpartiesPanel";
import BankFeedsPanel from "./BankFeedsPanel";
import SalesTaxPanel from "./SalesTaxPanel";

type PanelKey = "revenue" | "expenses" | "counterparties" | "bank-feeds" | "sales-tax";

const TABS: TabDef<PanelKey>[] = [
  { key: "revenue",        label: "Revenue" },
  { key: "expenses",       label: "Expenses" },
  { key: "counterparties", label: "Counterparties" },
  { key: "bank-feeds",     label: "Bank Feeds" },
  { key: "sales-tax",      label: "Sales Tax" },
];

const PANELS: Record<PanelKey, () => React.ReactElement> = {
  "revenue":        RevenuePanel,
  "expenses":       ExpensesPanel,
  "counterparties": CounterpartiesPanel,
  "bank-feeds":     BankFeedsPanel,
  "sales-tax":      SalesTaxPanel,
};

function initialPanel(param: string | null): PanelKey {
  return TABS.some((t) => t.key === param) ? (param as PanelKey) : "revenue";
}

export default function GlMappingPage() {
  const searchParams = useSearchParams();
  const [panel, setPanel] = useState<PanelKey>(() => initialPanel(searchParams.get("tab")));

  const Panel = PANELS[panel];

  return (
    <>
      <div className="shrink-0 px-4 sm:px-6 pt-4">
        <TabBar tabs={TABS} activeKey={panel} onSelect={setPanel} className="mb-0" />
      </div>
      <Panel />
    </>
  );
}
