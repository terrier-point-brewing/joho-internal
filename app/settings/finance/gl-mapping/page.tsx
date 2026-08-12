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
 * The panels switch via a ButtonGroup, not a second TabBar — the same thing
 * Chart of Accounts does for its Statement/By Type toggle, so a nested view
 * switcher never reads as another level of page navigation. docs/UI_STANDARD.md
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
import { type TabDef } from "@/app/components/TabBar";
import ButtonGroup from "@/app/components/ButtonGroup";
import SettingsHeader from "@/app/settings/SettingsHeader";
import RevenuePanel from "./RevenuePanel";
import ExpensesPanel from "./ExpensesPanel";
import CounterpartiesPanel from "./CounterpartiesPanel";
import BankFeedsPanel from "./BankFeedsPanel";
import SalesTaxPanel from "./SalesTaxPanel";
import RefundsPanel from "./RefundsPanel";

type PanelKey = "revenue" | "expenses" | "counterparties" | "bank-feeds" | "sales-tax" | "refunds";

// Refunds sits last, after Sales Tax: it is the only panel that maps an account
// to an ACCOUNT rather than an external thing to an account, and it is read
// after you already know where the sale itself was coded.
const TABS: TabDef<PanelKey>[] = [
  { key: "revenue",        label: "Revenue" },
  { key: "expenses",       label: "Expenses" },
  { key: "counterparties", label: "Counterparties" },
  { key: "bank-feeds",     label: "Bank Feeds" },
  { key: "sales-tax",      label: "Sales Tax" },
  { key: "refunds",        label: "Refunds" },
];

const PANELS: Record<PanelKey, (props: { selector?: React.ReactNode }) => React.ReactElement> = {
  "revenue":        RevenuePanel,
  "expenses":       ExpensesPanel,
  "counterparties": CounterpartiesPanel,
  "bank-feeds":     BankFeedsPanel,
  "sales-tax":      SalesTaxPanel,
  "refunds":        RefundsPanel,
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
      <div className="px-4 sm:px-6">
        <SettingsHeader
          title="GL Mapping"
          description="Where an external thing — a Square item, a Ramp charge, a bank feed — is given a chart-of-accounts code."
        />
      </div>
      <Panel selector={<ButtonGroup tabs={TABS} activeKey={panel} onSelect={setPanel} />} />
    </>
  );
}
