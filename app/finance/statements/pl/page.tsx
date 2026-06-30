"use client";
import { useState, useEffect, useCallback } from "react";
import FinanceNav from "../../FinanceNav";
import StatementsNav from "../StatementsNav";
import {
  buildTree, sumMonthly, SectionRows, SubtotalRow, MoMTableHead, StatementHeader,
  type TreeNode, type MoMAccount,
} from "../lib";
import type { AccountBalanceMoM } from "@/app/api/finance/statements/route";

// ── Page ──────────────────────────────────────────────────────────────────────

export default function PLPage() {
  const now = new Date();
  const currentYear = now.getFullYear();
  const [year, setYear] = useState(currentYear);
  const [data, setData] = useState<{ year: number; accounts: AccountBalanceMoM[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // null = uncontrolled (each section/row manages own state), true/false = global override
  const [expandAll, setExpandAll] = useState<boolean | null>(null);

  const years = Array.from({ length: 5 }, (_, i) => currentYear - i);

  useEffect(() => {
    async function load() {
      setLoading(true); setError(null);
      try {
        const r = await fetch(`/api/finance/statements?view=mom&year=${year}`);
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

  // Months to display: all 12 months for past years; Jan through current month for current year
  const maxMonth = year < currentYear ? 12 : now.getMonth() + 1;
  const months = Array.from({ length: maxMonth }, (_, i) =>
    `${year}-${String(i + 1).padStart(2, "0")}`
  );

  const accounts = data?.accounts ?? [];

  // Only P&L sections
  const plSections = new Set(["revenue", "other_income", "cogs", "expenses", "other_expense"]);
  const plAccounts = accounts.filter(a => plSections.has(a.section));

  const treeAll = buildTree(plAccounts);

  const filterSection = (section: string) =>
    treeAll.filter(n => n.acct.section === section);

  const revenue     = filterSection("revenue");
  const otherIncome = filterSection("other_income");
  const cogs        = filterSection("cogs");
  const expenses    = filterSection("expenses");
  const otherExp    = filterSection("other_expense");

  const sectionMonthTotals = (nodes: TreeNode<MoMAccount>[]) =>
    months.map(m => sumMonthly(nodes, m));

  const add = (a: number[], b: number[]) => a.map((v, i) => v + b[i]);

  const totalRevenueMo   = add(sectionMonthTotals(revenue), sectionMonthTotals(otherIncome));
  const totalCOGSMo      = sectionMonthTotals(cogs);
  const grossProfitMo    = totalRevenueMo.map((v, i) => v - totalCOGSMo[i]);
  const totalExpensesMo  = add(sectionMonthTotals(expenses), sectionMonthTotals(otherExp));
  const netIncomeMo      = grossProfitMo.map((v, i) => v - totalExpensesMo[i]);

  const handleExpandAll = useCallback((val: boolean) => {
    setExpandAll(val);
    setTimeout(() => setExpandAll(null), 50);
  }, [setExpandAll]);

  return (
    <div className="flex flex-col h-full bg-canvas text-primary">
      <FinanceNav mobile />

      <StatementHeader
        title="Profit & Loss"
        description={`Full Year ${year} · Square POS transactions and invoices mapped to Chart of Accounts`}
        onExpandAll={handleExpandAll}
      >
        <select
          value={year}
          onChange={(e) => { setYear(Number(e.target.value)); setExpandAll(null); }}
          className="inp-sm w-auto"
        >
          {years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
      </StatementHeader>
      <div className="px-4 sm:px-6 shrink-0">
        <StatementsNav />
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {loading && (
          <div className="flex items-center justify-center h-32">
            <p className="text-xs text-faint">Loading…</p>
          </div>
        )}
        {error && <p className="text-xs text-danger px-6 py-4">{error}</p>}

        {!loading && !error && (
          <table className="w-full border-collapse text-xs" style={{ minWidth: `${months.length * 96 + 280}px` }}>
            <MoMTableHead months={months} />
            <tbody>
              <SectionRows title="Revenue" nodes={revenue} months={months} totalLabel="Total Revenue" expandAll={expandAll} />
              {otherIncome.length > 0 && (
                <SectionRows title="Other Income" nodes={otherIncome} months={months} totalLabel="Total Other Income" expandAll={expandAll} />
              )}

              <SubtotalRow label="Total Income" monthTotals={totalRevenueMo} />

              <SectionRows title="Cost of Goods Sold" nodes={cogs} months={months} totalLabel="Total COGS" expandAll={expandAll} />

              <SubtotalRow label="Gross Profit" monthTotals={grossProfitMo} />

              <SectionRows title="Operating Expenses" nodes={expenses} months={months} totalLabel="Total Expenses" expandAll={expandAll} />
              {otherExp.length > 0 && (
                <SectionRows title="Other Expenses" nodes={otherExp} months={months} totalLabel="Total Other Expenses" expandAll={expandAll} />
              )}

              <SubtotalRow label="Net Income" monthTotals={netIncomeMo} highlight />

              <tr>
                <td colSpan={months.length + 2} className="px-4 py-4 text-[10px] text-faint">
                  Amounts reflect cash basis from synced Square POS transactions and mapped invoices.
                  Accounts with no mapped transactions show —.
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
