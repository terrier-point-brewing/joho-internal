"use client";
import { useState, useEffect, useCallback } from "react";
import { formatCurrencyCents } from "@/lib/format";
import DateRangeFilter from "../components/DateRangeFilter";
import AcceptUnmappedButton from "../components/AcceptUnmappedButton";
import { defaultYearRange } from "@/lib/finance/dateRange";
import SummaryStatBar from "../components/SummaryStatBar";
import Pagination from "../components/Pagination";
import { LedgerTable, Th } from "../components/LedgerTable";
import Badge from "@/app/components/ui/Badge";
import AccountSelect, { type CoARef } from "../../AccountSelect";
import Banner from "@/app/components/ui/Banner";
import SaveHint from "@/app/components/ui/SaveHint";
import SortableTh from "@/app/components/ui/SortableTh";
import SearchInput from "@/app/components/ui/SearchInput";
import FilterBar from "@/app/components/ui/FilterBar";
import FilterSelect from "@/app/components/ui/FilterSelect";
import GlAccountFilter from "../components/GlAccountFilter";
import RunJobButton from "@/app/components/RunJobButton";
import QbSyncBadge, { qbSyncFilterValue, QB_SYNC_FILTER_OPTIONS } from "../components/QbSyncBadge";
import { normalizeQbSyncStatus } from "@/lib/finance/qbSyncStatus";
import { useTableControls } from "@/app/components/ui/useTableControls";
import type { ControlsConfig } from "@/lib/table/types";
import {
  FLOW_GROUPS,
  FLOW_TYPES,
  flowTypesInGroup,
  getFlowType,
  flowNeedsAccount,
  type FlowType,
} from "@/lib/finance/flowTypes";

interface BankRow {
  id: string; amount_cents: number; description: string | null; counterparty_name: string | null;
  source_account_name: string | null; destination_account_name: string | null; flow_type: FlowType;
  affects_pl: boolean; transaction_date: string | null; chart_of_accounts_id: string | null;
  mapping_source: "unmapped" | "rule" | "manual";
  unmapped_accepted: boolean;
  qb_sync_status: string | null; qb_synced_at: string | null; qb_remote_id: string | null;
}

// No dedicated "warning" tone exists in app/components/ui/tone.ts (Tone = neutral | accent |
// success | danger | info) — "accent" is the codebase's convention for "needs review" states
// (see SummaryStatBar's needsReview stat and MappingStatusPill's partial state).
function flowTone(f: FlowType): "success" | "accent" | "neutral" {
  if (f === "unclassified") return "accent";
  return getFlowType(f)?.affectsPl ? "success" : "neutral";
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
    { param: "qbsync", accessor: (r) => qbSyncFilterValue(r.qb_sync_status) },
    // One GL account per bank row, so a plain accessor is enough and there is
    // nothing to narrow — the matching subtotal always equals the row total.
    { param: "gl", accessor: (r) => r.chart_of_accounts_id ?? "" },
  ],
  sort: {
    columns: [
      { key: "date", accessor: (r) => r.transaction_date ?? "" },
      { key: "amount", accessor: (r) => r.amount_cents },
    ],
    default: { key: "date", dir: "desc" },
  },
};
const FLOW_OPTIONS = FLOW_TYPES.map((f) => ({ value: f.key, label: f.label }));

const PAGE_SIZE = 50;


/**
 * One row's flow type, and the account that follows from it.
 *
 * ── Always a select, never a badge ───────────────────────────────────────────
 * This used to render the dropdown only while the row was `unclassified` and a
 * read-only Badge afterwards, which made every classification a ONE-WAY door: a
 * mis-pick could not be undone anywhere in the app. There is nothing dangerous
 * about changing a flow -- the API rewrites affects_pl and the account to match
 * -- so the control stays live.
 *
 * ── The consequence line ─────────────────────────────────────────────────────
 * The complaint this cell was rebuilt to answer is "I don't know what happens
 * when I pick one of these". So the chosen flow's `effect` sentence is rendered
 * underneath it, and the optgroup headings say the same thing a level up. Both
 * come from lib/finance/flowTypes.ts, which is also what the readers consult,
 * so the sentence cannot describe behaviour the code does not have.
 *
 * ── Why the account picker comes and goes ────────────────────────────────────
 * Four of the eight flows never use an account. Showing a picker for them
 * invites an operator to spend a decision on a field that is about to be
 * discarded, and the old grid did exactly that for every row.
 *
 * The one exception is a row that is still `unclassified` and ALREADY carries an
 * account -- a state only a hand-coded row from before this screen existed can
 * be in. Its account is shown read-only rather than hidden, because silently
 * concealing a stored value that still feeds the balance sheet is worse than
 * showing a state that should not exist.
 */
function FlowCell({ row, accounts, saving, onPatch, onToggleAccept }: {
  row: BankRow;
  accounts: CoARef[];
  saving: boolean;
  onPatch: (patch: { flow_type?: FlowType; chart_of_accounts_id?: string | null }) => void;
  onToggleAccept: () => Promise<void>;
}) {
  const def = getFlowType(row.flow_type);
  const needsAccount = flowNeedsAccount(row.flow_type);
  const orphanedAccount = !needsAccount && row.chart_of_accounts_id !== null;

  return (
    <div className="flex flex-col gap-1 min-w-[220px]">
      <div className="flex items-center gap-1.5">
        <select
          className="inp-sm w-full"
          value={row.flow_type}
          onChange={(e) => onPatch({ flow_type: e.target.value as FlowType })}
        >
          {/* A stored value this build does not know: shown rather than silently
              re-reading as whatever happens to sort first, which would look like
              the row had been quietly reclassified. */}
          {!def && <option value={row.flow_type}>{row.flow_type} (unknown)</option>}
          {FLOW_GROUPS.map((group) => (
            <optgroup key={group} label={group}>
              {flowTypesInGroup(group).map((f) => (
                <option key={f.key} value={f.key}>{f.label}</option>
              ))}
            </optgroup>
          ))}
        </select>
        {row.mapping_source === "rule" && (
          <span className="text-2xs text-info shrink-0" title="Set by a counterparty rule">auto</span>
        )}
        <SaveHint saving={saving} />
      </div>

      {def && <p className="text-2xs text-faint leading-snug">{def.effect}</p>}

      {needsAccount && (
        <AccountSelect
          value={row.chart_of_accounts_id}
          onChange={(coaId) => onPatch({ chart_of_accounts_id: coaId })}
          accounts={accounts}
          placeholder="— GL account —"
          shortLabel
          className="w-full"
        />
      )}

      {orphanedAccount && (
        <p className="text-2xs text-accent leading-snug">
          An account is still set on this row. Pick a flow above that uses one, or it will be cleared.
        </p>
      )}

      {row.flow_type === "unclassified" && (
        <AcceptUnmappedButton accepted={row.unmapped_accepted} onToggle={onToggleAccept} />
      )}
    </div>
  );
}

export default function BankLedgerPage() {
  const [{ from, to }, setRange] = useState(() => defaultYearRange());
  const [accounts, setAccounts] = useState<CoARef[]>([]);
  const [rows, setRows] = useState<BankRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [page, setPage] = useState(1);

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
    setSavingId(id);
    try {
      const res = await fetch("/api/finance/bank-ledger", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, ...patch }) });
      if (!res.ok) return;
      const upd = await res.json();
      setRows((rs) => rs.map((r) => r.id === id ? { ...r, flow_type: upd.flow_type ?? r.flow_type, affects_pl: upd.affects_pl ?? r.affects_pl, chart_of_accounts_id: upd.chart_of_accounts_id ?? null, mapping_source: upd.mapping_source ?? r.mapping_source, unmapped_accepted: upd.unmapped_accepted ?? r.unmapped_accepted } : r));
    } finally {
      setSavingId((cur) => (cur === id ? null : cur));
    }
  }

  async function handleToggleAccept(id: string, accepted: boolean) {
    await patchRow(id, { unmapped_accepted: accepted });
  }

  // Summary stats — always computed over the full `rows` array, never the page slice below.
  const needsReview = rows.filter((r) => r.flow_type === "unclassified" && !r.unmapped_accepted).length;
  const plNet = rows.filter((r) => r.affects_pl).reduce((s, r) => s + r.amount_cents, 0);
  const inQbCount = rows.filter((r) => normalizeQbSyncStatus(r.qb_sync_status) === "synced").length;

  const { rows: visible, search, filters, sort, setSearch, setFilter, toggleSort, reset, activeCount } =
    useTableControls(rows, BANK_CONTROLS);

  // Display pagination over the already-filtered `visible` array (client-side
  // slice — fetch/search/filter/sort/summary all stay on the full set).
  const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const safePage    = Math.min(page, totalPages);
  const pagedVisible = visible.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setPage(1); }, [from, to, search.q, JSON.stringify(filters)]);

  return (
    <>
      <div className="shrink-0 px-4 sm:px-6 py-2">
        <FilterBar activeCount={activeCount} onClear={reset}>
          <SearchInput value={search.q ?? ""} onChange={(v) => setSearch("q", v)} placeholder="Search counterparty…" />
          <DateRangeFilter from={from} to={to} onChange={(f, t) => setRange({ from: f, to: t })} />
          <FilterSelect label="Flow" options={FLOW_OPTIONS} value={filters.flow ?? []}
            onChange={(v) => setFilter("flow", v)} />
          <FilterSelect label="QB Sync" options={QB_SYNC_FILTER_OPTIONS} value={filters.qbsync ?? []}
            onChange={(v) => setFilter("qbsync", v)} />
          <GlAccountFilter accounts={accounts} value={filters.gl?.[0] ?? null}
            onChange={(id) => setFilter("gl", id ? [id] : [])} />
          {/* Two feeds land in this ledger and neither can refresh the other, so
              both are offered here rather than sending someone to the Expenses
              tab for one of them. */}
          <RunJobButton job="ramp-expenses-sync" label="Refresh Ramp" onFinished={() => loadAll(from, to)} />
          <RunJobButton job="bank-transactions-sync" label="Refresh bank feed" onFinished={() => loadAll(from, to)} />
        </FilterBar>
      </div>
      {error && <Banner className="mx-4 sm:mx-6 my-2">{error}</Banner>}
      {loading ? (
        <div className="flex-1 flex items-center justify-center"><p className="text-xs text-muted">Loading…</p></div>
      ) : rows.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-center px-6">
          <p className="text-sm text-secondary">No bank-account activity for {from} – {to}. Use the refresh buttons above to import it.</p>
        </div>
      ) : (
        <>
        <div className="flex-1 min-h-0 flex flex-col px-4 sm:px-6 py-4">
          <LedgerTable fill head={<>
            <SortableTh label="Date" sortKey="date" sort={sort} onSort={toggleSort} />
            <Th label="Counterparty" /><Th label="Description" /><Th label="Flow" /><Th label="P&L" /><Th label="QB Sync" />
            <SortableTh label="Amount" sortKey="amount" sort={sort} onSort={toggleSort} align="right" />
          </>}>
            {pagedVisible.map((r) => (
              <tr key={r.id} className="border-t border-line/40">
                <td className="px-4 py-2 text-secondary whitespace-nowrap">{fmtDate(r.transaction_date)}</td>
                <td className="px-4 py-2 text-body">{r.counterparty_name ?? "—"}</td>
                <td className="px-4 py-2 text-secondary">{r.description ?? "—"}</td>
                <td className="px-4 py-2">
                  <FlowCell
                    row={r}
                    accounts={accounts}
                    saving={savingId === r.id}
                    onPatch={(patch) => patchRow(r.id, patch)}
                    onToggleAccept={() => handleToggleAccept(r.id, !r.unmapped_accepted)}
                  />
                </td>
                <td className="px-4 py-2 text-2xs text-faint">{r.affects_pl ? "yes" : "—"}</td>
                <td className="px-4 py-2"><QbSyncBadge status={r.qb_sync_status} rampObject="bank" /></td>
                <td className="px-4 py-2 text-right font-mono tabular-nums text-strong">{formatCurrencyCents(r.amount_cents)}</td>
              </tr>
            ))}
          </LedgerTable>
          <p className="py-3 text-2xs text-faint">The flow type decides what happens to a line, and the sentence under each one says which. Only <span className="text-accent">operating expense</span> and <span className="text-accent">income</span> reach the P&amp;L; settlements and transfers are deliberately left out so the card, bill and sale records they pay off are not counted twice. Any line can be recoded at any time. To stop answering the same question every month, give the counterparty a standing flow under Settings → Finance → GL Mapping → Counterparties.</p>
        </div>
        <Pagination page={safePage} totalPages={totalPages} total={visible.length} unit="bank lines" onPageChange={setPage} />
        </>
      )}

      {rows.length > 0 && (
        <SummaryStatBar stats={[
          { label: "Lines", value: rows.length },
          { label: "Needs review", value: needsReview, tone: needsReview > 0 ? "accent" : "secondary" },
          { label: "In QuickBooks", value: `${inQbCount} / ${rows.length}` },
          { label: "P&L impact", value: formatCurrencyCents(plNet) },
        ]} />
      )}
    </>
  );
}
