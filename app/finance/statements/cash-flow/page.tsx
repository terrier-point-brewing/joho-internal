"use client";
import { useState, useEffect, useCallback } from "react";
import FinanceNav from "../../FinanceNav";
import StatementsNav from "../StatementsNav";
import {
  buildTree, sumMonthly, SectionRows, SubtotalRow, MoMTableHead, StatementHeader,
  type TreeNode, type MoMAccount,
} from "../lib";
import type { AccountBalanceMoM } from "@/app/api/finance/statements/route";

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

  const sectionMonthTotals = (nodes: TreeNode<MoMAccount>[]) => months.map(m => sumMonthly(nodes, m));
  const add = (a: number[], b: number[]) => a.map((v, i) => v + b[i]);

  const totalCashInMo    = add(sectionMonthTotals(revenue), sectionMonthTotals(otherIncome));
  const totalCashOutMo   = add(add(sectionMonthTotals(cogs), sectionMonthTotals(expenses)), sectionMonthTotals(otherExp));
  const netCashMo        = totalCashInMo.map((v, i) => v - totalCashOutMo[i]);

  return (
    <div className="flex flex-col h-full bg-canvas text-primary">
      <FinanceNav mobile />

      <StatementHeader
        title="Cash Flow — Operating"
        description={`Full Year ${year} · direct method · cash collected/paid per CoA account · Square sources only`}
        onExpandAll={handleExpandAll}
      >
        <select value={year} onChange={(e) => { setYear(Number(e.target.value)); setExpandAll(null); }}
          className="inp-sm w-auto">
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
          <table className="w-full border-collapse text-xs" style={{ minWidth: `${months.length * 96 + 280}px` }}>
            <MoMTableHead months={months} />
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
                <td colSpan={months.length + 2} className="px-4 py-4 text-[10px] text-faint">
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
