"use client";
import { useState, useEffect, useCallback } from "react";
import { formatCurrencyCents } from "@/lib/format";
import DateRangeFilter from "../components/DateRangeFilter";
import AcceptUnmappedButton from "../components/AcceptUnmappedButton";
import { defaultYearRange } from "@/lib/finance/dateRange";
import SummaryStatBar from "../components/SummaryStatBar";
import { LedgerTable, Th } from "../components/LedgerTable";
import Badge from "@/app/components/ui/Badge";
import AccountSelect, { type CoARef } from "../../AccountSelect";
import Banner from "@/app/components/ui/Banner";
import SortableTh from "@/app/components/ui/SortableTh";
import SearchInput from "@/app/components/ui/SearchInput";
import FilterBar from "@/app/components/ui/FilterBar";
import FilterSelect from "@/app/components/ui/FilterSelect";
import { useTableControls } from "@/app/components/ui/useTableControls";
import type { ControlsConfig } from "@/lib/table/types";

const FLOW_TYPES = ["interest_income", "internal_transfer", "bill_settlement", "card_settlement", "deposit", "unclassified"] as const;
type FlowType = typeof FLOW_TYPES[number];

interface BankRow {
  id: string; amount_cents: number; description: string | null; counterparty_name: string | null;
  source_account_name: string | null; destination_account_name: string | null; flow_type: FlowType;
  affects_pl: boolean; transaction_date: string | null; chart_of_accounts_id: string | null;
  mapping_source: "unmapped" | "rule" | "manual";
  unmapped_accepted: boolean;
}

// No dedicated "warning" tone exists in app/components/ui/tone.ts (Tone = neutral | accent |
// success | danger | info) — "accent" is the codebase's convention for "needs review" states
// (see SummaryStatBar's needsReview stat and MappingStatusPill's partial state).
function flowTone(f: FlowType): "success" | "accent" | "neutral" {
  if (f === "unclassified") return "accent";
  if (f === "interest_income") return "success";
  return "neutral";
}
function fmtDate(s: string | null) {
  if (!s) return "—";
  const [y, m, d] = s.split("-");
  return new Date(Number(y), Number(m) - 1, Number(d)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// ── Search/filter/sort config ────────────────────────────────────────────────

const BANK_CONTROLS: ControlsConfig<BankRow> = {
  search: [{ param: "q", accessor: (r) => [r.counterparty_name, r.description] }],
  filters: [
    { param: "flow", accessor: (r) => r.flow_type },
  ],
  sort: {
    columns: [
      { key: "date", accessor: (r) => r.transaction_date ?? "" },
      { key: "amount", accessor: (r) => r.amount_cents },
    ],
    default: { key: "date", dir: "desc" },
  },
};
// No dedicated flow-type label map exists in this file; the row Badge already
// displays flow_type via the same underscore-to-space transform — reuse it.
const FLOW_OPTIONS = FLOW_TYPES.map((f) => ({ value: f, label: f.replace(/_/g, " ") }));

export default function BankLedgerPage() {
  const [{ from, to }, setRange] = useState(() => defaultYearRange());
  const [accounts, setAccounts] = useState<CoARef[]>([]);
  const [rows, setRows] = useState<BankRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadAll = useCallback(async (from: string, to: string) => {
    setLoading(true); setError(null);
    try {
      const [coaRes, res] = await Promise.all([
        fetch("/api/finance/chart-of-accounts"),
        fetch(`/api/finance/bank-ledger?from=${from}&to=${to}`),
      ]);
      const [coa, data] = await Promise.all([coaRes.json(), res.json()]);
      setAccounts(Array.isArray(coa) ? coa : []);
      setRows(Array.isArray(data) ? data : []);
    } catch { setError("Failed to load bank ledger."); }
    finally { setLoading(false); }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { loadAll(from, to); }, [loadAll, from, to]);

  async function patchRow(id: string, patch: { flow_type?: FlowType; chart_of_accounts_id?: string | null; unmapped_accepted?: boolean }) {
    const res = await fetch("/api/finance/bank-ledger", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, ...patch }) });
    if (!res.ok) return;
    const upd = await res.json();
    setRows((rs) => rs.map((r) => r.id === id ? { ...r, flow_type: upd.flow_type ?? r.flow_type, affects_pl: upd.affects_pl ?? r.affects_pl, chart_of_accounts_id: upd.chart_of_accounts_id ?? null, mapping_source: upd.mapping_source ?? r.mapping_source, unmapped_accepted: upd.unmapped_accepted ?? r.unmapped_accepted } : r));
  }

  async function handleToggleAccept(id: string, accepted: boolean) {
    await patchRow(id, { unmapped_accepted: accepted });
  }

  const needsReview = rows.filter((r) => r.flow_type === "unclassified" && !r.unmapped_accepted).length;
  const plNet = rows.filter((r) => r.affects_pl).reduce((s, r) => s + r.amount_cents, 0);

  const { rows: visible, search, filters, sort, setSearch, setFilter, toggleSort, reset, activeCount } =
    useTableControls(rows, BANK_CONTROLS);

  return (
    <>
      <div className="shrink-0 px-4 sm:px-6 py-3 border-b border-line flex items-center gap-3 flex-wrap">
        <FilterBar activeCount={activeCount} onClear={reset}>
          <SearchInput value={search.q ?? ""} onChange={(v) => setSearch("q", v)} placeholder="Search counterparty…" />
          <DateRangeFilter from={from} to={to} onChange={(f, t) => setRange({ from: f, to: t })} />
          <FilterSelect label="Flow" options={FLOW_OPTIONS} value={filters.flow ?? []}
            onChange={(v) => setFilter("flow", v)} />
        </FilterBar>
      </div>
      {rows.length > 0 && (
        <SummaryStatBar stats={[
          { label: "Lines", value: rows.length },
          { label: "Needs review", value: needsReview, tone: needsReview > 0 ? "accent" : "secondary" },
          { label: "P&L impact", value: formatCurrencyCents(plNet) },
        ]} />
      )}
      {error && <Banner className="mx-4 sm:mx-6 my-2">{error}</Banner>}
      {loading ? (
        <div className="flex-1 flex items-center justify-center"><p className="text-xs text-muted">Loading…</p></div>
      ) : rows.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-center px-6">
          <p className="text-sm text-secondary">No bank-account activity for {from} – {to}. Click &ldquo;Sync Ramp&rdquo; on the Expenses tab to import.</p>
        </div>
      ) : (
        <div className="flex-1 overflow-auto px-4 sm:px-6 py-4">
          <LedgerTable head={<>
            <SortableTh label="Date" sortKey="date" sort={sort} onSort={toggleSort} />
            <Th label="Counterparty" /><Th label="Description" /><Th label="Flow" /><Th label="P&L" />
            <SortableTh label="Amount" sortKey="amount" sort={sort} onSort={toggleSort} align="right" />
          </>}>
            {visible.map((r) => (
              <tr key={r.id} className="border-t border-line/40">
                <td className="px-4 py-2 text-secondary whitespace-nowrap">{fmtDate(r.transaction_date)}</td>
                <td className="px-4 py-2 text-body">{r.counterparty_name ?? "—"}</td>
                <td className="px-4 py-2 text-secondary">{r.description ?? "—"}</td>
                <td className="px-4 py-2">
                  {r.flow_type === "unclassified" ? (
                    <div className="flex flex-col gap-1 min-w-[180px]">
                      <select className="inp-sm" value={r.flow_type} onChange={(e) => patchRow(r.id, { flow_type: e.target.value as FlowType })}>
                        {FLOW_TYPES.map((f) => <option key={f} value={f}>{f}</option>)}
                      </select>
                      <AccountSelect
                        value={r.chart_of_accounts_id}
                        onChange={(coaId) => patchRow(r.id, { chart_of_accounts_id: coaId })}
                        accounts={accounts}
                        placeholder="— GL account —"
                        shortLabel
                        className="w-full"
                      />
                      <AcceptUnmappedButton accepted={r.unmapped_accepted} onToggle={() => handleToggleAccept(r.id, !r.unmapped_accepted)} />
                    </div>
                  ) : <Badge tone={flowTone(r.flow_type)}>{r.flow_type.replace(/_/g, " ")}</Badge>}
                </td>
                <td className="px-4 py-2 text-[10px] text-faint">{r.affects_pl ? "yes" : "—"}</td>
                <td className="px-4 py-2 text-right font-mono tabular-nums text-strong">{formatCurrencyCents(r.amount_cents)}</td>
              </tr>
            ))}
          </LedgerTable>
          <p className="py-3 text-[10px] text-faint">Bank lines are classified on sync. Settlements and internal transfers are excluded from P&amp;L to avoid double-counting card and bill records. Recode an <span className="text-accent">unclassified</span> line above.</p>
        </div>
      )}
    </>
  );
}
