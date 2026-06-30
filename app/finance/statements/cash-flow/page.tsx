"use client";
import { useState, useEffect, useCallback } from "react";
import { formatCurrencyCents } from "@/lib/format";
import FinanceNav from "../../FinanceNav";
import StatementsNav from "../StatementsNav";
import type { AccountBalanceMoM } from "@/app/api/finance/statements/route";

// ── Constants / helpers (shared pattern with P&L page) ────────────────────────

const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function fmtCents(cents: number): string {
  if (cents === 0) return "—";
  const neg = cents < 0;
  const abs = formatCurrencyCents(Math.abs(cents));
  return neg ? `(${abs})` : abs;
}

function MoneyCell({ cents, dim }: { cents: number; dim?: boolean }) {
  if (cents === 0) return <span className="text-zinc-700">—</span>;
  const neg = cents < 0;
  const abs = formatCurrencyCents(Math.abs(cents));
  const text = neg ? `(${abs})` : abs;
  return <span className={dim ? "text-zinc-500" : neg ? "text-red-400" : "text-zinc-200"}>{text}</span>;
}

function shortName(name: string, parentName: string | undefined): string {
  if (!parentName) return name;
  const prefix = parentName + ":";
  if (name.startsWith(prefix)) return name.slice(prefix.length).trim();
  const prefixSpace = parentName + " : ";
  if (name.startsWith(prefixSpace)) return name.slice(prefixSpace.length).trim();
  return name;
}

// ── Tree (identical to P&L) ───────────────────────────────────────────────────

interface TreeNode {
  acct: AccountBalanceMoM;
  children: TreeNode[];
}

function buildTree(accounts: AccountBalanceMoM[]): TreeNode[] {
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

function sumMonthly(nodes: TreeNode[], monthKey: string): number {
  let total = 0;
  for (const n of nodes) {
    total += n.acct.monthly[monthKey]?.cents ?? 0;
    total += sumMonthly(n.children, monthKey);
  }
  return total;
}

function totalForNode(node: TreeNode, months: string[]): number {
  return months.reduce((s, m) => s + (node.acct.monthly[m]?.cents ?? 0), 0)
    + node.children.reduce((s, c) => s + totalForNode(c, months), 0);
}

// ── Row components (identical pattern to P&L) ─────────────────────────────────

function AccountRow({ node, months, depth, parentName, expandAll }: {
  node: TreeNode; months: string[]; depth: number; parentName?: string; expandAll: boolean | null;
}) {
  const hasChildren = node.children.length > 0;
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (expandAll !== null) setExpanded(expandAll);
  }, [expandAll]);

  const displayName = shortName(node.acct.account_name, parentName);
  const rowTotal = totalForNode(node, months);
  const hasData = rowTotal !== 0 || months.some(m => (node.acct.monthly[m]?.cents ?? 0) !== 0);

  return (
    <>
      <tr className={`border-t border-zinc-800/40 hover:bg-zinc-900/20 ${!hasData ? "opacity-40" : ""}`}>
        <td className="py-1.5 pr-3 text-xs whitespace-nowrap" style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }}>
          <div className="flex items-center gap-1.5 min-w-0">
            {hasChildren && (
              <button onClick={() => setExpanded(e => !e)} className="text-zinc-600 hover:text-zinc-400 w-3 shrink-0 text-[10px]">
                {expanded ? "▾" : "▸"}
              </button>
            )}
            {!hasChildren && <span className="w-3 shrink-0" />}
            {node.acct.account_number && (
              <span className="text-zinc-600 font-mono text-[10px] shrink-0">{node.acct.account_number}</span>
            )}
            <span className={`truncate ${hasChildren ? "font-medium text-zinc-200" : "text-zinc-400"}`}>
              {displayName}
            </span>
          </div>
        </td>
        {months.map(m => {
          const own = node.acct.monthly[m]?.cents ?? 0;
          const childSum = node.children.reduce((s, c) => s + totalForNode(c, [m]), 0);
          const effective = own + childSum;
          return (
            <td key={m} className="py-1.5 px-2 text-right font-mono tabular-nums text-xs">
              {hasChildren && !expanded
                ? <MoneyCell cents={effective} />
                : <MoneyCell cents={own} dim={hasChildren} />}
            </td>
          );
        })}
        <td className="py-1.5 pl-2 pr-4 text-right font-mono tabular-nums text-xs font-semibold">
          <MoneyCell cents={rowTotal} />
        </td>
      </tr>
      {expanded && node.children.map(child => (
        <AccountRow key={child.acct.id} node={child} months={months} depth={depth + 1}
          parentName={node.acct.account_name} expandAll={expandAll} />
      ))}
    </>
  );
}

function SectionRows({ title, nodes, months, totalLabel, expandAll, pendingNote }: {
  title: string; nodes: TreeNode[]; months: string[]; totalLabel: string;
  expandAll: boolean | null; pendingNote?: string;
}) {
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (expandAll !== null) setExpanded(expandAll);
  }, [expandAll]);

  const hasData = nodes.some(n => totalForNode(n, months) !== 0);
  const sectionTotals = months.map(m => sumMonthly(nodes, m));
  const grandTotal = sectionTotals.reduce((s, c) => s + c, 0);

  return (
    <>
      <tr className="border-t border-zinc-700/60 bg-zinc-900/60">
        <td colSpan={months.length + 2} className="py-0">
          <button onClick={() => setExpanded(e => !e)}
            className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-zinc-800/40 transition-colors">
            <span className="text-zinc-500 text-[10px] w-3">{expanded ? "▾" : "▸"}</span>
            <span className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider">{title}</span>
            {pendingNote
              ? <span className="text-[10px] text-zinc-700 italic">{pendingNote}</span>
              : !hasData && <span className="text-[10px] text-zinc-700 italic">no mapped transactions</span>}
          </button>
        </td>
      </tr>

      {expanded && nodes.map(node => (
        <AccountRow key={node.acct.id} node={node} months={months} depth={0}
          parentName={undefined} expandAll={expandAll} />
      ))}

      <tr className="border-t border-zinc-700/60 bg-zinc-900/40">
        <td className="py-1.5 px-4 text-xs text-zinc-400 font-medium">{totalLabel}</td>
        {sectionTotals.map((cents, i) => (
          <td key={months[i]} className="py-1.5 px-2 text-right font-mono tabular-nums text-xs font-semibold text-zinc-200">
            {fmtCents(cents)}
          </td>
        ))}
        <td className="py-1.5 pl-2 pr-4 text-right font-mono tabular-nums text-xs font-bold text-zinc-100">
          {fmtCents(grandTotal)}
        </td>
      </tr>
    </>
  );
}

function SubtotalRow({ label, monthTotals, highlight }: {
  label: string; monthTotals: number[]; highlight?: boolean;
}) {
  const grand = monthTotals.reduce((s, c) => s + c, 0);
  return (
    <tr className={`border-t-2 border-zinc-600 ${highlight ? "bg-zinc-800/50" : "bg-zinc-900/60"}`}>
      <td className={`py-2 px-4 text-xs font-bold ${highlight ? "text-zinc-100" : "text-zinc-200"}`}>{label}</td>
      {monthTotals.map((cents, i) => (
        <td key={i} className={`py-2 px-2 text-right font-mono tabular-nums text-xs font-bold ${cents < 0 ? "text-red-400" : highlight ? "text-amber-300" : "text-zinc-100"}`}>
          {fmtCents(cents)}
        </td>
      ))}
      <td className={`py-2 pl-2 pr-4 text-right font-mono tabular-nums text-sm font-bold ${grand < 0 ? "text-red-400" : highlight ? "text-amber-300" : "text-zinc-100"}`}>
        {fmtCents(grand)}
      </td>
    </tr>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function CashFlowPage() {
  const now = new Date();
  const currentYear = now.getFullYear();
  const [year, setYear] = useState(currentYear);
  const [data, setData] = useState<{ year: number; accounts: AccountBalanceMoM[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandAll, setExpandAll] = useState<boolean | null>(null);
  const years = Array.from({ length: 5 }, (_, i) => currentYear - i);

  useEffect(() => {
    async function load() {
      setLoading(true); setError(null);
      try {
        const r = await fetch(`/api/finance/statements?view=cash&year=${year}`);
        const d = await r.json();
        setData(d);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load");
      } finally { setLoading(false); }
    }
    load();
  }, [year]);

  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  const handleExpandAll = useCallback((val: boolean) => {
    setExpandAll(val);
    setTimeout(() => setExpandAll(null), 50);
  }, []);

  const maxMonth = year < currentYear ? 12 : now.getMonth() + 1;
  const months = Array.from({ length: maxMonth }, (_, i) =>
    `${year}-${String(i + 1).padStart(2, "0")}`
  );

  const accounts = data?.accounts ?? [];
  const plSections = new Set(["revenue", "other_income", "cogs", "expenses", "other_expense"]);
  const treeAll = buildTree(accounts.filter(a => plSections.has(a.section)));
  const filterSection = (section: string) => treeAll.filter(n => n.acct.section === section);

  const revenue     = filterSection("revenue");
  const otherIncome = filterSection("other_income");
  const cogs        = filterSection("cogs");
  const expenses    = filterSection("expenses");
  const otherExp    = filterSection("other_expense");

  const sectionMonthTotals = (nodes: TreeNode[]) => months.map(m => sumMonthly(nodes, m));
  const add = (a: number[], b: number[]) => a.map((v, i) => v + b[i]);

  const totalCashInMo    = add(sectionMonthTotals(revenue), sectionMonthTotals(otherIncome));
  const totalCashOutMo   = add(add(sectionMonthTotals(cogs), sectionMonthTotals(expenses)), sectionMonthTotals(otherExp));
  const netCashMo        = totalCashInMo.map((v, i) => v - totalCashOutMo[i]);

  return (
    <div className="flex flex-col h-full bg-zinc-950 text-zinc-100">
      <FinanceNav mobile />

      <div className="shrink-0 px-4 sm:px-6 pt-4 sm:pt-5 pb-3 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-base font-semibold text-zinc-100">Cash Flow — Operating</h1>
          <p className="text-xs text-zinc-500 mt-0.5">
            {`Full Year ${year}`} · direct method · cash collected/paid per CoA account · Square sources only
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
          <select value={year} onChange={(e) => { setYear(Number(e.target.value)); setExpandAll(null); }}
            className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-200">
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
      </div>
      <StatementsNav />

      <div className="flex-1 overflow-auto">
        {loading && <div className="flex items-center justify-center h-32"><p className="text-xs text-zinc-600">Loading…</p></div>}
        {error && <p className="text-xs text-red-400 px-6 py-4">{error}</p>}

        {!loading && !error && (
          <table className="w-full border-collapse text-xs" style={{ minWidth: `${months.length * 96 + 280}px` }}>
            <thead>
              <tr className="bg-zinc-900 border-b border-zinc-800 sticky top-0 z-10">
                <th className="py-2 px-4 text-left text-[10px] text-zinc-600 uppercase tracking-wider font-medium w-64">Account</th>
                {months.map((m, i) => (
                  <th key={m} className="py-2 px-2 text-right text-[10px] text-zinc-500 uppercase tracking-wider font-medium w-24">
                    {MONTH_NAMES[i]}
                  </th>
                ))}
                <th className="py-2 pl-2 pr-4 text-right text-[10px] text-zinc-400 uppercase tracking-wider font-semibold w-28">Total</th>
              </tr>
            </thead>
            <tbody>
              {/* Cash In */}
              <SectionRows title="Cash Collected — Revenue" nodes={revenue} months={months}
                totalLabel="Total Revenue Collected" expandAll={expandAll} />
              {otherIncome.length > 0 && (
                <SectionRows title="Cash Collected — Other Income" nodes={otherIncome} months={months}
                  totalLabel="Total Other Income Collected" expandAll={expandAll} />
              )}
              <SubtotalRow label="Total Cash In" monthTotals={totalCashInMo} />

              {/* Cash Out — will be populated by Ramp */}
              <SectionRows title="Cash Paid — Cost of Goods Sold" nodes={cogs} months={months}
                totalLabel="Total COGS Paid" expandAll={expandAll}
                pendingNote={cogs.length === 0 ? "Ramp integration pending" : undefined} />
              <SectionRows title="Cash Paid — Operating Expenses" nodes={expenses} months={months}
                totalLabel="Total Expenses Paid" expandAll={expandAll}
                pendingNote={expenses.length === 0 ? "Ramp integration pending" : undefined} />
              {otherExp.length > 0 && (
                <SectionRows title="Cash Paid — Other Expenses" nodes={otherExp} months={months}
                  totalLabel="Total Other Expenses Paid" expandAll={expandAll} />
              )}
              <SubtotalRow label="Total Cash Out" monthTotals={totalCashOutMo} />

              <SubtotalRow label="Net Operating Cash Flow" monthTotals={netCashMo} highlight />

              <tr>
                <td colSpan={months.length + 2} className="px-4 py-4 text-[10px] text-zinc-700">
                  Cash In: Square POS (net sales) + paid Square invoices, by CoA account.
                  Cash Out: expense accounts pending Ramp integration.
                  Difference from P&amp;L = uncollected revenue (open invoices = A/R on Balance Sheet).
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
