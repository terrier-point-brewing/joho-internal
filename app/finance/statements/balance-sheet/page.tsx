"use client";
import { useState, useEffect } from "react";
import FinanceNav from "../../FinanceNav";
import StatementsNav from "../StatementsNav";
import type { AccountBalance } from "@/app/api/finance/statements/route";

function fmtMoneyRaw(cents: number): string {
  if (cents === 0) return "—";
  const neg = cents < 0;
  const abs = "$" + Math.abs(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return neg ? `(${abs})` : abs;
}

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
          {!hasData && <span className="text-[10px] text-zinc-600 italic">no data</span>}
        </div>
        <span className="text-xs font-mono font-semibold text-zinc-200 tabular-nums">{fmtMoneyRaw(totalCents)}</span>
      </button>

      {expanded && accounts.length > 0 && (
        <div className="pb-1">
          {accounts.map((acct) => (
            <div key={acct.id}
              className="grid grid-cols-[minmax(0,1fr)_100px] gap-4 px-8 sm:px-10 py-1.5 text-xs border-t border-zinc-800/30 hover:bg-zinc-900/20">
              <div className="flex items-center gap-2 min-w-0">
                {acct.account_number && (
                  <span className="text-zinc-600 font-mono shrink-0">{acct.account_number}</span>
                )}
                <span className={`truncate ${acct.balance_cents !== 0 ? "text-zinc-300" : "text-zinc-600"}`}>
                  {acct.account_name}
                </span>
              </div>
              <span className="text-right font-mono tabular-nums self-center text-zinc-400">
                {fmtMoneyRaw(acct.balance_cents)}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between px-4 sm:px-6 py-2 bg-zinc-900/40 border-t border-zinc-800/60">
        <span className="text-xs text-zinc-400 font-medium">{totalLabel}</span>
        <span className="text-xs font-mono font-semibold tabular-nums text-zinc-100">{fmtMoneyRaw(totalCents)}</span>
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
        {fmtMoneyRaw(cents)}
      </span>
    </div>
  );
}

export default function BalanceSheetPage() {
  const currentYear = new Date().getFullYear();
  const [year, setYear]       = useState(currentYear);
  const [data, setData]       = useState<{ year: number; accounts: AccountBalance[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const years = Array.from({ length: 5 }, (_, i) => currentYear - i);

  useEffect(() => {
    async function load() {
      setLoading(true); setError(null);
      try {
        const r = await fetch(`/api/finance/statements?year=${year}`);
        const d = await r.json();
        setData(d);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [year]);

  const accounts = data?.accounts ?? [];
  const sum = (list: AccountBalance[]) => list.reduce((s, a) => s + a.balance_cents, 0);

  // Assets
  const bank             = accounts.filter((a) => a.section === "bank");
  const ar               = accounts.filter((a) => a.section === "ar");
  const otherCurrentAssets = accounts.filter((a) => a.section === "other_current_assets");
  const fixedAssets      = accounts.filter((a) => a.section === "fixed_assets");
  const totalCurrentAssets = sum(bank) + sum(ar) + sum(otherCurrentAssets);
  const totalAssets      = totalCurrentAssets + sum(fixedAssets);

  // Liabilities
  const ap               = accounts.filter((a) => a.section === "ap");
  const creditCard       = accounts.filter((a) => a.section === "credit_card");
  const otherCurrentLiab = accounts.filter((a) => a.section === "other_current_liabilities");
  const longTermLiab     = accounts.filter((a) => a.section === "long_term_liabilities");
  const totalCurrentLiab = sum(ap) + sum(creditCard) + sum(otherCurrentLiab);
  const totalLiab        = totalCurrentLiab + sum(longTermLiab);

  // Equity
  const equity           = accounts.filter((a) => a.section === "equity");
  // Net income (from P&L) — revenue minus COGS minus expenses
  const revenue          = accounts.filter((a) => a.section === "revenue" || a.section === "other_income");
  const cogs             = accounts.filter((a) => a.section === "cogs");
  const expenses         = accounts.filter((a) => a.section === "expenses" || a.section === "other_expense");
  const netIncome        = sum(revenue) - sum(cogs) - sum(expenses);
  const totalEquity      = sum(equity) + netIncome;
  const totalLiabEquity  = totalLiab + totalEquity;

  return (
    <div className="flex flex-col h-full bg-zinc-950 text-zinc-100">
      <FinanceNav mobile />
      <StatementsNav />

      <div className="shrink-0 px-4 sm:px-6 pt-4 sm:pt-5 pb-3 border-b border-zinc-800 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-base font-semibold text-zinc-100">Balance Sheet</h1>
          <p className="text-xs text-zinc-500 mt-0.5">As of Dec 31, {year} — based on Chart of Accounts structure</p>
        </div>
        <select value={year} onChange={(e) => setYear(Number(e.target.value))}
          className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-200">
          {years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
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
            {/* ASSETS */}
            <GroupHeader label="Assets" />
            <Section title="Bank & Cash" accounts={bank} totalLabel="Total Bank & Cash" totalCents={sum(bank)} />
            <Section title="Accounts Receivable" accounts={ar} totalLabel="Total A/R" totalCents={sum(ar)} defaultExpanded={false} />
            <Section title="Other Current Assets" accounts={otherCurrentAssets} totalLabel="Total Other Current Assets" totalCents={sum(otherCurrentAssets)} defaultExpanded={false} />
            <GroupTotal label="Total Current Assets" cents={totalCurrentAssets} />
            <Section title="Fixed Assets" accounts={fixedAssets} totalLabel="Total Fixed Assets" totalCents={sum(fixedAssets)} defaultExpanded={false} />
            <GroupTotal label="Total Assets" cents={totalAssets} />

            <div className="h-4" />

            {/* LIABILITIES */}
            <GroupHeader label="Liabilities" />
            <Section title="Accounts Payable" accounts={ap} totalLabel="Total A/P" totalCents={sum(ap)} defaultExpanded={false} />
            <Section title="Credit Cards" accounts={creditCard} totalLabel="Total Credit Cards" totalCents={sum(creditCard)} defaultExpanded={false} />
            <Section title="Other Current Liabilities" accounts={otherCurrentLiab} totalLabel="Total Other Current Liabilities" totalCents={sum(otherCurrentLiab)} defaultExpanded={false} />
            <GroupTotal label="Total Current Liabilities" cents={totalCurrentLiab} />
            <Section title="Long-Term Liabilities" accounts={longTermLiab} totalLabel="Total Long-Term Liabilities" totalCents={sum(longTermLiab)} defaultExpanded={false} />
            <GroupTotal label="Total Liabilities" cents={totalLiab} />

            <div className="h-4" />

            {/* EQUITY */}
            <GroupHeader label="Equity" />
            <Section title="Equity" accounts={equity} totalLabel="Total Equity Accounts" totalCents={sum(equity)} defaultExpanded={false} />
            {/* Net income line from P&L */}
            <div className="flex items-center justify-between px-8 sm:px-10 py-1.5 text-xs border-t border-zinc-800/30">
              <span className="text-zinc-400">Net Income ({year})</span>
              <span className={`font-mono tabular-nums ${netIncome < 0 ? "text-red-400" : "text-zinc-300"}`}>{fmtMoneyRaw(netIncome)}</span>
            </div>
            <div className="flex items-center justify-between px-4 sm:px-6 py-2 bg-zinc-900/40 border-t border-zinc-800/60 border-b border-zinc-800/60">
              <span className="text-xs text-zinc-400 font-medium">Total Equity</span>
              <span className="text-xs font-mono font-semibold tabular-nums text-zinc-100">{fmtMoneyRaw(totalEquity)}</span>
            </div>
            <GroupTotal label="Total Liabilities + Equity" cents={totalLiabEquity} />

            <div className="px-4 sm:px-6 py-4 text-[10px] text-zinc-600">
              Balance Sheet account balances are not yet sourced from a general ledger.
              Only accounts with mapped transactions show non-zero values. Import journal entries or connect a GL source to populate asset, liability, and equity balances.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
