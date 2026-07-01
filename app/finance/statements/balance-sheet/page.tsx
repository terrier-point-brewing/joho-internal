"use client";
import { useState, useEffect, useCallback } from "react";
import FinanceNav from "../../FinanceNav";
import StatementsNav from "../StatementsNav";
import {
  MONTH_NAMES, fmtCents as fmtMoney, shortName, buildTree, StatementHeader,
  type TreeNode,
} from "../lib";
import type { AccountBalance } from "@/app/api/finance/statements/route";

// ── Balance-sheet specific tree math ────────────────────────────────────────────

function nodeBalance(node: TreeNode<AccountBalance>): number {
  return node.acct.balance_cents + node.children.reduce((s, c) => s + nodeBalance(c), 0);
}

// ── AccountRow ────────────────────────────────────────────────────────────────

function AccountRow({
  node,
  depth,
  parentName,
  expandAll,
}: {
  node: TreeNode<AccountBalance>;
  depth: number;
  parentName?: string;
  expandAll: boolean | null;
}) {
  const hasChildren = node.children.length > 0;
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (expandAll !== null) setExpanded(expandAll);
  }, [expandAll]);

  const displayName = shortName(node.acct.account_name, parentName);
  const total = nodeBalance(node);

  return (
    <>
      <div
        className={`grid grid-cols-[minmax(0,1fr)_100px] gap-4 py-1.5 border-t border-line/30 hover:bg-surface/20 ${total === 0 ? "opacity-40" : ""}`}
        style={{ paddingLeft: `${(depth + 1) * 20 + 12}px`, paddingRight: "24px" }}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          {hasChildren ? (
            <button onClick={() => setExpanded(e => !e)} className="text-faint hover:text-secondary w-3 shrink-0 text-[10px]">
              {expanded ? "▾" : "▸"}
            </button>
          ) : (
            <span className="w-3 shrink-0" />
          )}
          {node.acct.account_number && (
            <span className="text-faint font-mono text-[10px] shrink-0">{node.acct.account_number}</span>
          )}
          <span className={`truncate text-xs ${hasChildren ? "font-medium text-strong" : "text-secondary"}`}>
            {displayName}
          </span>
        </div>
        <span className="text-right font-mono tabular-nums text-xs self-center text-secondary">
          {hasChildren && !expanded ? fmtMoney(total) : fmtMoney(node.acct.balance_cents)}
        </span>
      </div>
      {expanded && node.children.map(child => (
        <AccountRow
          key={child.acct.id}
          node={child}
          depth={depth + 1}
          parentName={node.acct.account_name}
          expandAll={expandAll}
        />
      ))}
    </>
  );
}

// ── Section ───────────────────────────────────────────────────────────────────

function Section({
  title,
  nodes,
  totalLabel,
  expandAll,
}: {
  title: string;
  nodes: TreeNode<AccountBalance>[];
  totalLabel: string;
  expandAll: boolean | null;
}) {
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (expandAll !== null) setExpanded(expandAll);
  }, [expandAll]);

  const totalCents = nodes.reduce((s, n) => s + nodeBalance(n), 0);
  const hasData = totalCents !== 0;

  return (
    <div className="border-b border-line/60">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between px-4 sm:px-6 py-3 hover:bg-surface/30 transition-colors text-left">
        <div className="flex items-center gap-2">
          <span className="text-faint text-xs w-3">{expanded ? "▾" : "▸"}</span>
          <span className="text-xs font-semibold text-body uppercase tracking-wider">{title}</span>
          {!hasData && <span className="text-[10px] text-faint italic">no mapped data</span>}
        </div>
        <span className="text-xs font-mono font-semibold text-strong tabular-nums">{fmtMoney(totalCents)}</span>
      </button>

      {expanded && nodes.length > 0 && (
        <div className="pb-1">
          {nodes.map(node => (
            <AccountRow key={node.acct.id} node={node} depth={0} expandAll={expandAll} />
          ))}
        </div>
      )}

      <div className="flex items-center justify-between px-4 sm:px-6 py-2 bg-surface/40 border-t border-line/60">
        <span className="text-xs text-secondary font-medium">{totalLabel}</span>
        <span className="text-xs font-mono font-semibold tabular-nums text-primary">{fmtMoney(totalCents)}</span>
      </div>
    </div>
  );
}

function GroupHeader({ label }: { label: string }) {
  return (
    <div className="px-4 sm:px-6 py-2 bg-surface border-b border-line">
      <span className="text-[11px] font-bold text-secondary uppercase tracking-widest">{label}</span>
    </div>
  );
}

function GroupTotal({ label, cents }: { label: string; cents: number }) {
  return (
    <div className="flex items-center justify-between px-4 sm:px-6 py-3 bg-surface-mid/50 border-b border-line-strong">
      <span className="text-sm font-bold text-strong">{label}</span>
      <span className={`text-sm font-mono font-bold tabular-nums ${cents < 0 ? "text-danger" : "text-primary"}`}>
        {fmtMoney(cents)}
      </span>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function BalanceSheetPage() {
  const now = new Date();
  const currentYear  = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  const [year, setYear]   = useState(currentYear);
  const [month, setMonth] = useState(currentMonth);
  const [data, setData]   = useState<{ year: number; accounts: AccountBalance[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]    = useState<string | null>(null);
  const [expandAll, setExpandAll] = useState<boolean | null>(null);
  const years = Array.from({ length: 5 }, (_, i) => currentYear - i);

  useEffect(() => {
    async function load() {
      setLoading(true); setError(null);
      try {
        const params = new URLSearchParams({ year: String(year), cumulative: "true" });
        if (month > 0) params.set("month", String(month));
        const r = await fetch(`/api/finance/statements?${params}`);
        const d = await r.json();
        setData(d);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load");
      } finally { setLoading(false); }
    }
    load();
  }, [year, month]);

  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  const handleExpandAll = useCallback((val: boolean) => {
    setExpandAll(val);
    setTimeout(() => setExpandAll(null), 50);
  }, []);

  const accounts = data?.accounts ?? [];
  const sum = (nodes: TreeNode<AccountBalance>[]) => nodes.reduce((s, n) => s + nodeBalance(n), 0);

  const bsSections = new Set(["bank","ar","other_current_assets","fixed_assets","ap","credit_card","other_current_liabilities","long_term_liabilities","equity"]);
  const treeAll = buildTree(accounts.filter(a => bsSections.has(a.section)));

  const filterSection = (section: string) => treeAll.filter(n => n.acct.section === section);

  const bank              = filterSection("bank");
  const ar                = filterSection("ar");
  const otherCurrentAssets = filterSection("other_current_assets");
  const fixedAssets       = filterSection("fixed_assets");
  const totalCurrentAssets = sum(bank) + sum(ar) + sum(otherCurrentAssets);
  const totalAssets       = totalCurrentAssets + sum(fixedAssets);

  const ap                = filterSection("ap");
  const creditCard        = filterSection("credit_card");
  const otherCurrentLiab  = filterSection("other_current_liabilities");
  const longTermLiab      = filterSection("long_term_liabilities");
  const totalCurrentLiab  = sum(ap) + sum(creditCard) + sum(otherCurrentLiab);
  const totalLiab         = totalCurrentLiab + sum(longTermLiab);

  const equity            = filterSection("equity");
  // Net income rolls into equity: use all P&L accounts (cumulative through period)
  const plAccounts        = accounts.filter(a => ["revenue","other_income","cogs","expenses","other_expense"].includes(a.section));
  const netIncome         = plAccounts
    .filter(a => ["revenue","other_income"].includes(a.section))
    .reduce((s, a) => s + a.balance_cents, 0)
    - plAccounts
    .filter(a => ["cogs","expenses","other_expense"].includes(a.section))
    .reduce((s, a) => s + a.balance_cents, 0);
  const totalEquity       = sum(equity) + netIncome;
  const totalLiabEquity   = totalLiab + totalEquity;

  const periodLabel = month > 0
    ? `${MONTH_NAMES[month - 1]} ${year}`
    : `Dec 31, ${year}`;

  return (
    <div className="flex flex-col h-full bg-canvas text-primary">
      <FinanceNav mobile />

      <StatementHeader
        title="Balance Sheet"
        description={`As of ${periodLabel} · cumulative from inception`}
        onExpandAll={handleExpandAll}
      >
        <select value={month} onChange={(e) => setMonth(Number(e.target.value))} className="inp-sm w-auto">
          <option value={0}>Annual (Dec 31)</option>
          {MONTH_NAMES.map((m, i) => <option key={i + 1} value={i + 1}>{m}</option>)}
        </select>
        <select value={year} onChange={(e) => setYear(Number(e.target.value))} className="inp-sm w-auto">
          {years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
      </StatementHeader>
      <div className="px-4 sm:px-6 shrink-0">
        <StatementsNav />
      </div>

      <div className="flex-1 overflow-auto">
        {loading && <div className="flex items-center justify-center h-32"><p className="text-xs text-faint">Loading…</p></div>}
        {error && <p className="text-xs text-danger px-6 py-4">{error}</p>}

        {!loading && !error && (
          <>
            <GroupHeader label="Assets" />
            <Section title="Bank & Cash" nodes={bank} totalLabel="Total Bank & Cash" expandAll={expandAll} />
            <Section title="Accounts Receivable" nodes={ar} totalLabel="Total A/R" expandAll={expandAll} />
            <Section title="Other Current Assets" nodes={otherCurrentAssets} totalLabel="Total Other Current Assets" expandAll={expandAll} />
            <GroupTotal label="Total Current Assets" cents={totalCurrentAssets} />
            <Section title="Fixed Assets" nodes={fixedAssets} totalLabel="Total Fixed Assets" expandAll={expandAll} />
            <GroupTotal label="Total Assets" cents={totalAssets} />

            <div className="h-4" />

            <GroupHeader label="Liabilities" />
            <Section title="Accounts Payable" nodes={ap} totalLabel="Total A/P" expandAll={expandAll} />
            <Section title="Credit Cards" nodes={creditCard} totalLabel="Total Credit Cards" expandAll={expandAll} />
            <Section title="Other Current Liabilities" nodes={otherCurrentLiab} totalLabel="Total Other Current Liabilities" expandAll={expandAll} />
            <GroupTotal label="Total Current Liabilities" cents={totalCurrentLiab} />
            <Section title="Long-Term Liabilities" nodes={longTermLiab} totalLabel="Total Long-Term Liabilities" expandAll={expandAll} />
            <GroupTotal label="Total Liabilities" cents={totalLiab} />

            <div className="h-4" />

            <GroupHeader label="Equity" />
            <Section title="Equity" nodes={equity} totalLabel="Total Equity Accounts" expandAll={expandAll} />
            <div className="flex items-center justify-between px-10 py-1.5 text-xs border-t border-line/30">
              <span className="text-secondary">Net Income (cumulative through {periodLabel})</span>
              <span className={`font-mono tabular-nums ${netIncome < 0 ? "text-danger" : "text-body"}`}>{fmtMoney(netIncome)}</span>
            </div>
            <div className="flex items-center justify-between px-4 sm:px-6 py-2 bg-surface/40 border-t border-line/60 border-b border-line/60">
              <span className="text-xs text-secondary font-medium">Total Equity</span>
              <span className="text-xs font-mono font-semibold tabular-nums text-primary">{fmtMoney(totalEquity)}</span>
            </div>
            <GroupTotal label="Total Liabilities + Equity" cents={totalLiabEquity} />

            <div className="px-4 sm:px-6 py-4 text-[10px] text-faint">
              A/R reflects open invoices as of this date. Deposit invoices pending delivery are recorded to their mapped BS account.
              Ramp expenses mapped to a balance-sheet account (e.g. fixed assets, credit card) are included; full bank and equity balances still require manual journal entries.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
