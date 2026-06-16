"use client";
import { useState, useEffect, useCallback } from "react";
import FinanceNav from "../../FinanceNav";
import StatementsNav from "../StatementsNav";
import type { AccountBalance } from "@/app/api/finance/statements/route";

// ── Helpers ───────────────────────────────────────────────────────────────────

const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function fmtMoney(cents: number): string {
  if (cents === 0) return "—";
  const neg = cents < 0;
  const abs = "$" + Math.abs(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return neg ? `(${abs})` : abs;
}

function shortName(name: string, parentName: string | undefined): string {
  if (!parentName) return name;
  const prefix = parentName + ":";
  if (name.startsWith(prefix)) return name.slice(prefix.length).trim();
  const prefixSpace = parentName + " : ";
  if (name.startsWith(prefixSpace)) return name.slice(prefixSpace.length).trim();
  return name;
}

// ── Tree ─────────────────────────────────────────────────────────────────────

interface TreeNode {
  acct: AccountBalance & { parent_id?: string | null };
  children: TreeNode[];
}

function buildTree(accounts: (AccountBalance & { parent_id?: string | null })[]): TreeNode[] {
  const byId = new Map<string, TreeNode>();
  for (const acct of accounts) byId.set(acct.id, { acct, children: [] });
  const roots: TreeNode[] = [];
  for (const node of byId.values()) {
    const pid = node.acct.parent_id;
    if (pid && byId.has(pid)) byId.get(pid)!.children.push(node);
    else roots.push(node);
  }
  return roots;
}

function nodeBalance(node: TreeNode): number {
  return node.acct.balance_cents + node.children.reduce((s, c) => s + nodeBalance(c), 0);
}

// ── Row ───────────────────────────────────────────────────────────────────────

function AccountRow({
  node,
  depth,
  parentName,
  expandAll,
}: {
  node: TreeNode;
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
        className={`grid grid-cols-[minmax(0,1fr)_100px] gap-4 py-1.5 text-xs border-t border-zinc-800/30 hover:bg-zinc-900/20 ${total === 0 ? "opacity-40" : ""}`}
        style={{ paddingLeft: `${(depth + 1) * 20 + 16}px`, paddingRight: "24px" }}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          {hasChildren ? (
            <button onClick={() => setExpanded(e => !e)} className="text-zinc-600 hover:text-zinc-400 w-3 shrink-0 text-[10px]">
              {expanded ? "▾" : "▸"}
            </button>
          ) : (
            <span className="w-3 shrink-0" />
          )}
          {node.acct.account_number && (
            <span className="text-zinc-600 font-mono text-[10px] shrink-0">{node.acct.account_number}</span>
          )}
          <span className={`truncate ${hasChildren ? "font-medium text-zinc-200" : "text-zinc-400"}`}>
            {displayName}
          </span>
        </div>
        <span className="text-right font-mono tabular-nums self-center text-zinc-400">
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
  nodes: TreeNode[];
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
    <div className="border-b border-zinc-800/60">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between px-4 sm:px-6 py-3 hover:bg-zinc-900/30 transition-colors text-left">
        <div className="flex items-center gap-2">
          <span className="text-zinc-600 text-xs w-3">{expanded ? "▾" : "▸"}</span>
          <span className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">{title}</span>
          {!hasData && <span className="text-[10px] text-zinc-600 italic">no mapped transactions</span>}
        </div>
        <span className="text-xs font-mono font-semibold text-zinc-200 tabular-nums">{fmtMoney(totalCents)}</span>
      </button>

      {expanded && nodes.length > 0 && (
        <div className="pb-1">
          {nodes.map(node => (
            <AccountRow key={node.acct.id} node={node} depth={0} expandAll={expandAll} />
          ))}
        </div>
      )}

      <div className="flex items-center justify-between px-4 sm:px-6 py-2 bg-zinc-900/40 border-t border-zinc-800/60">
        <span className="text-xs text-zinc-400 font-medium">{totalLabel}</span>
        <span className="text-xs font-mono font-semibold tabular-nums text-zinc-100">{fmtMoney(totalCents)}</span>
      </div>
    </div>
  );
}

function GroupHeader({ label }: { label: string }) {
  return (
    <div className="px-4 sm:px-6 py-2 bg-zinc-900 border-b border-zinc-800">
      <span className="text-[11px] font-bold text-zinc-400 uppercase tracking-widest">{label}</span>
    </div>
  );
}

function GroupTotal({ label, cents }: { label: string; cents: number }) {
  return (
    <div className="flex items-center justify-between px-4 sm:px-6 py-3 bg-zinc-800/50 border-b border-zinc-700">
      <span className="text-sm font-bold text-zinc-200">{label}</span>
      <span className={`text-sm font-mono font-bold tabular-nums ${cents < 0 ? "text-red-400" : "text-zinc-100"}`}>
        {fmtMoney(cents)}
      </span>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

type BSAccount = AccountBalance & { parent_id?: string | null };

export default function BalanceSheetPage() {
  const now = new Date();
  const currentYear  = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  const [year, setYear]   = useState(currentYear);
  const [month, setMonth] = useState(currentMonth);
  const [data, setData]   = useState<{ year: number; accounts: BSAccount[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]    = useState<string | null>(null);
  const [expandAll, setExpandAll] = useState<boolean | null>(null);
  const years = Array.from({ length: 5 }, (_, i) => currentYear - i);

  useEffect(() => {
    async function load() {
      setLoading(true); setError(null);
      try {
        const params = month > 0 ? `year=${year}&month=${month}` : `year=${year}`;
        const r = await fetch(`/api/finance/statements?${params}`);
        const d = await r.json();
        setData(d);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [year, month]);

  const handleExpandAll = useCallback((val: boolean) => {
    setExpandAll(val);
    setTimeout(() => setExpandAll(null), 50); // eslint-disable-line react-hooks/set-state-in-effect
  }, []);

  const accounts = data?.accounts ?? [];
  const sum = (nodes: TreeNode[]) => nodes.reduce((s, n) => s + nodeBalance(n), 0);

  const bsSections = new Set(["bank", "ar", "other_current_assets", "fixed_assets", "ap", "credit_card", "other_current_liabilities", "long_term_liabilities", "equity"]);
  const bsAccounts = accounts.filter(a => bsSections.has(a.section));
  const treeAll = buildTree(bsAccounts);

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
  const revenue           = accounts.filter(a => a.section === "revenue" || a.section === "other_income");
  const cogs              = accounts.filter(a => a.section === "cogs");
  const expenses          = accounts.filter(a => a.section === "expenses" || a.section === "other_expense");
  const netIncome         = revenue.reduce((s, a) => s + a.balance_cents, 0)
                          - cogs.reduce((s, a) => s + a.balance_cents, 0)
                          - expenses.reduce((s, a) => s + a.balance_cents, 0);
  const totalEquity       = sum(equity) + netIncome;
  const totalLiabEquity   = totalLiab + totalEquity;

  return (
    <div className="flex flex-col h-full bg-zinc-950 text-zinc-100">
      <FinanceNav mobile />
      <StatementsNav />

      <div className="shrink-0 px-4 sm:px-6 pt-4 sm:pt-5 pb-3 border-b border-zinc-800 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-base font-semibold text-zinc-100">Balance Sheet</h1>
          <p className="text-xs text-zinc-500 mt-0.5">
            As of {month > 0 ? `${MONTH_NAMES[month - 1]} ${year}` : `Dec 31, ${year}`} · based on Chart of Accounts structure
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={() => handleExpandAll(true)}
            className="px-2.5 py-1.5 text-[10px] text-zinc-400 border border-zinc-700 rounded hover:bg-zinc-800 hover:text-zinc-200 transition-colors">
            Expand All
          </button>
          <button onClick={() => handleExpandAll(false)}
            className="px-2.5 py-1.5 text-[10px] text-zinc-400 border border-zinc-700 rounded hover:bg-zinc-800 hover:text-zinc-200 transition-colors">
            Collapse All
          </button>
          <select value={month} onChange={(e) => setMonth(Number(e.target.value))}
            className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-200">
            <option value={0}>Annual</option>
            {MONTH_NAMES.map((m, i) => <option key={i + 1} value={i + 1}>{m}</option>)}
          </select>
          <select value={year} onChange={(e) => setYear(Number(e.target.value))}
            className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-200">
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {loading && (
          <div className="flex items-center justify-center h-32">
            <p className="text-xs text-zinc-600">Loading…</p>
          </div>
        )}
        {error && <p className="text-xs text-red-400 px-6 py-4">{error}</p>}

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
            <div className="flex items-center justify-between px-10 py-1.5 text-xs border-t border-zinc-800/30">
              <span className="text-zinc-400">Net Income ({year})</span>
              <span className={`font-mono tabular-nums ${netIncome < 0 ? "text-red-400" : "text-zinc-300"}`}>{fmtMoney(netIncome)}</span>
            </div>
            <div className="flex items-center justify-between px-4 sm:px-6 py-2 bg-zinc-900/40 border-t border-zinc-800/60 border-b border-zinc-800/60">
              <span className="text-xs text-zinc-400 font-medium">Total Equity</span>
              <span className="text-xs font-mono font-semibold tabular-nums text-zinc-100">{fmtMoney(totalEquity)}</span>
            </div>
            <GroupTotal label="Total Liabilities + Equity" cents={totalLiabEquity} />

            <div className="px-4 sm:px-6 py-4 text-[10px] text-zinc-600">
              Deposit invoices with a BS account mapped (pending delivery) are reflected here.
              Open invoice A/R, Ramp credit card balances, bank balances, and equity require additional data sources.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
