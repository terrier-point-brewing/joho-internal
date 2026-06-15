"use client";
import { useState, useEffect } from "react";
import FinanceNav from "../../FinanceNav";
import StatementsNav from "../StatementsNav";
import type { AccountBalance } from "@/app/api/finance/statements/route";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtMoney(cents: number, opts?: { parens?: boolean }) {
  if (cents === 0) return <span className="text-zinc-600">—</span>;
  const neg = cents < 0;
  const abs = Math.abs(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const str = `$${abs}`;
  if (opts?.parens && neg) return <span className="text-red-400">({`$${Math.abs(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`})</span>;
  return <span className={neg ? "text-red-400" : ""}>{str}</span>;
}

function fmtMoneyRaw(cents: number): string {
  if (cents === 0) return "—";
  return "$" + Math.abs(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Section component ─────────────────────────────────────────────────────────

function Section({
  title,
  accounts,
  totalLabel,
  totalCents,
  defaultExpanded = true,
}: {
  title: string;
  accounts: AccountBalance[];
  totalLabel: string;
  totalCents: number;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const hasData = accounts.some((a) => a.balance_cents !== 0);

  return (
    <div className="border-b border-zinc-800/60">
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center justify-between px-4 sm:px-6 py-3 hover:bg-zinc-900/30 transition-colors text-left">
        <div className="flex items-center gap-2">
          <span className="text-zinc-600 text-xs w-3">{expanded ? "▾" : "▸"}</span>
          <span className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">{title}</span>
          {!hasData && <span className="text-[10px] text-zinc-600 italic">no mapped transactions</span>}
        </div>
        <span className="text-xs font-mono font-semibold text-zinc-200 tabular-nums">{fmtMoneyRaw(totalCents)}</span>
      </button>

      {expanded && accounts.length > 0 && (
        <div className="pb-1">
          {accounts.map((acct) => (
            <div key={acct.id}
              className="grid grid-cols-[minmax(0,1fr)_80px_100px] gap-4 px-8 sm:px-10 py-1.5 text-xs border-t border-zinc-800/30 hover:bg-zinc-900/20">
              <div className="flex items-center gap-2 min-w-0">
                {acct.account_number && (
                  <span className="text-zinc-600 font-mono shrink-0">{acct.account_number}</span>
                )}
                <span className={`truncate ${acct.balance_cents !== 0 ? "text-zinc-300" : "text-zinc-600"}`}>
                  {acct.account_name}
                </span>
              </div>
              <span className="text-[10px] text-zinc-600 text-right self-center">
                {acct.source_count > 0 ? `${acct.source_count} txn` : ""}
              </span>
              <span className="text-right font-mono tabular-nums self-center">
                {fmtMoney(acct.balance_cents)}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Section total row */}
      <div className="flex items-center justify-between px-4 sm:px-6 py-2 bg-zinc-900/40 border-t border-zinc-800/60">
        <span className="text-xs text-zinc-400 font-medium">{totalLabel}</span>
        <span className="text-xs font-mono font-semibold tabular-nums text-zinc-100">{fmtMoneyRaw(totalCents)}</span>
      </div>
    </div>
  );
}

// ── Subtotal row ──────────────────────────────────────────────────────────────

function Subtotal({ label, cents, highlight }: { label: string; cents: number; highlight?: boolean }) {
  return (
    <div className={`flex items-center justify-between px-4 sm:px-6 py-3 border-b border-zinc-700 ${highlight ? "bg-zinc-800/60" : "bg-zinc-900/60"}`}>
      <span className={`text-sm font-semibold ${highlight ? "text-zinc-100" : "text-zinc-200"}`}>{label}</span>
      <span className={`text-sm font-mono font-bold tabular-nums ${cents < 0 ? "text-red-400" : highlight ? "text-amber-300" : "text-zinc-100"}`}>
        {cents === 0 ? "—" : (cents < 0 ? "(" : "") + "$" + Math.abs(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 }) + (cents < 0 ? ")" : "")}
      </span>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

export default function PLPage() {
  const now = new Date();
  const currentYear  = now.getFullYear();
  const currentMonth = now.getMonth() + 1; // 1-based
  const [year, setYear]           = useState(currentYear);
  const [month, setMonth]         = useState(currentMonth); // 0 = annual
  const [data, setData]           = useState<{ year: number; accounts: AccountBalance[] } | null>(null);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState<string | null>(null);
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

  const accounts = data?.accounts ?? [];

  // Group by P&L section
  const revenue     = accounts.filter((a) => a.section === "revenue");
  const otherIncome = accounts.filter((a) => a.section === "other_income");
  const cogs        = accounts.filter((a) => a.section === "cogs");
  const expenses    = accounts.filter((a) => a.section === "expenses");
  const otherExp    = accounts.filter((a) => a.section === "other_expense");

  const sum = (list: AccountBalance[]) => list.reduce((s, a) => s + a.balance_cents, 0);

  const totalRevenue     = sum(revenue) + sum(otherIncome);
  const totalCOGS        = sum(cogs);
  const grossProfit      = totalRevenue - totalCOGS;
  const totalExpenses    = sum(expenses) + sum(otherExp);
  const netIncome        = grossProfit - totalExpenses;

  return (
    <div className="flex flex-col h-full bg-zinc-950 text-zinc-100">
      <FinanceNav mobile />
      <StatementsNav />

      <div className="shrink-0 px-4 sm:px-6 pt-4 sm:pt-5 pb-3 border-b border-zinc-800 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-base font-semibold text-zinc-100">Profit & Loss</h1>
          <p className="text-xs text-zinc-500 mt-0.5">
            {month > 0 ? `${MONTH_NAMES[month - 1]} ${year}` : `Full Year ${year}`}
            {" · "}Square POS transactions and invoices mapped to Chart of Accounts
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
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
            {/* Column headers */}
            <div className="grid grid-cols-[minmax(0,1fr)_80px_100px] gap-4 px-4 sm:px-6 py-2 bg-zinc-900 border-b border-zinc-800 sticky top-0 z-10">
              <span className="text-[10px] text-zinc-600 uppercase tracking-wider">Account</span>
              <span className="text-[10px] text-zinc-600 uppercase tracking-wider text-right">Transactions</span>
              <span className="text-[10px] text-zinc-600 uppercase tracking-wider text-right">
              {month > 0 ? `${MONTH_NAMES[month - 1]} ${year}` : year}
            </span>
            </div>

            <Section title="Revenue" accounts={revenue} totalLabel="Total Revenue" totalCents={sum(revenue)} />
            {otherIncome.length > 0 && (
              <Section title="Other Income" accounts={otherIncome} totalLabel="Total Other Income" totalCents={sum(otherIncome)} defaultExpanded={false} />
            )}

            <Subtotal label="Total Income" cents={totalRevenue} />

            <Section title="Cost of Goods Sold" accounts={cogs} totalLabel="Total COGS" totalCents={totalCOGS} />

            <Subtotal label="Gross Profit" cents={grossProfit} />

            <Section title="Operating Expenses" accounts={expenses} totalLabel="Total Expenses" totalCents={totalExpenses} defaultExpanded={false} />
            {otherExp.length > 0 && (
              <Section title="Other Expenses" accounts={otherExp} totalLabel="Total Other Expenses" totalCents={sum(otherExp)} defaultExpanded={false} />
            )}

            <Subtotal label="Net Income" cents={netIncome} highlight />

            <div className="px-4 sm:px-6 py-4 text-[10px] text-zinc-600">
              Amounts reflect cash basis from synced Square POS transactions and mapped invoices. Accounts with no mapped transactions show —.
              Map line items to Chart of Accounts in the Transactions and Invoices tabs to populate this report.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
