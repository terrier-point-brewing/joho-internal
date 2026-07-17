"use client";
import { useState, useEffect, useMemo } from "react";
import { formatCurrencyCents } from "@/lib/format";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { fetchJson } from "@/app/production/hooks/queries";
import type { Invoice, InvoiceType } from "@/types/finance";
import Banner from "@/app/components/ui/Banner";
import SortableTh from "@/app/components/ui/SortableTh";
import SearchInput from "@/app/components/ui/SearchInput";
import FilterSelect from "@/app/components/ui/FilterSelect";
import FilterBar from "@/app/components/ui/FilterBar";
import { useTableControls } from "@/app/components/ui/useTableControls";
import type { ControlsConfig } from "@/lib/table/types";
import AccountSelect from "../../AccountSelect";
import SyncPanel from "../components/SyncPanel";
import MappingFilter from "../components/MappingFilter";
import MappingStatusPill from "../components/MappingStatusPill";
import AutoMapButton from "../components/AutoMapButton";
import DateRangeFilter from "../components/DateRangeFilter";
import AcceptUnmappedButton from "../components/AcceptUnmappedButton";
import SummaryStatBar from "../components/SummaryStatBar";
import { LedgerTable, Th } from "../components/LedgerTable";
import { mappingState, matchesMappingFilter, type MappingFilterValue } from "@/lib/finance/mappingStatus";
import { defaultYearRange } from "@/lib/finance/dateRange";
import {
  INVOICE_STATUS_CLS, INVOICE_SOURCE_LABEL, INVOICE_SOURCE_CLS,
  INVOICE_TYPE_LABEL, INVOICE_TYPE_CLS,
} from "../../lib/categoryColors";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(s: string | null) {
  if (!s) return "—";
  const [y, m, d] = s.split("-");
  return new Date(Number(y), Number(m) - 1, Number(d)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fmtDollars(cents: number) {
  if (cents === 0) return <span className="text-faint">—</span>;
  return <span>{formatCurrencyCents(cents, 0)}</span>;
}

// Shared 7-column grid template for the expanded-row line-item table (header,
// each line row, and the invoice-level discount/tax summary rows below it) so
// columns always line up. Only the grid-template-columns + gap live here —
// callers append their own padding/typography so utility classes never fight
// each other in the generated stylesheet.
const LINE_GRID_COLS = "grid grid-cols-[minmax(0,1.4fr)_minmax(0,1.4fr)_50px_80px_70px_80px_minmax(0,1fr)] gap-3";

const STATUS_CLS = INVOICE_STATUS_CLS;
const SOURCE_LABEL = INVOICE_SOURCE_LABEL;
const SOURCE_CLS = INVOICE_SOURCE_CLS;
const TYPE_LABEL = INVOICE_TYPE_LABEL;
const TYPE_CLS = INVOICE_TYPE_CLS;


// ── Invoice list with joined data ─────────────────────────────────────────────

interface CoARef { id: string; account_name: string; account_number: string | null; account_type: string }

interface InvoiceLineItemRow {
  id: string;
  sort_order: number | null;
  description: string;
  line_item_name: string | null;
  note: string | null;
  category: string | null;
  quantity: number | null;
  unit_price_cents: number;
  discount_cents: number | null;
  net_sales_cents: number | null;
  total_cents: number;
  variation_name: string | null;
  square_catalog_variation_id: string | null;
  chart_of_accounts_id: string | null;
  chart_of_accounts: CoARef | null;
}

interface InvoiceRow extends Omit<Invoice, "invoice_line_items"> {
  invoice_line_items: InvoiceLineItemRow[];
  invoice_batch_links: { count: number }[];
  contract_brewing_partners: { company_name: string } | null;
  invoice_type: InvoiceType;
  allocation_id: string | null;
  unmapped_accepted: boolean;
}

// ── Search / filter / sort config (module scope) ──────────────────────────────

/** [mapped line items, total line items] for the GL-mapping filter. */
function invoiceMapped(inv: InvoiceRow): [number, number] {
  const items = inv.invoice_line_items ?? [];
  return [items.filter((li) => li.chart_of_accounts_id).length, items.length];
}

const INVOICE_CONTROLS: ControlsConfig<InvoiceRow> = {
  search: [{ param: "q", accessor: (i) => [i.invoice_number, i.customer_name] }],
  filters: [
    { param: "status", accessor: (i) => i.status ?? "" },
    { param: "type", accessor: (i) => i.invoice_type },
    {
      param: "mapping",
      matches: (i, sel) => {
        const [m, n] = invoiceMapped(i);
        return matchesMappingFilter(sel[0] as MappingFilterValue, m, n, i.unmapped_accepted);
      },
    },
  ],
  sort: {
    columns: [
      { key: "invoice_number", accessor: (i) => i.invoice_number ?? i.square_invoice_id ?? "" },
      { key: "invoice_date", accessor: (i) => i.invoice_date ?? "" },
      { key: "customer_name", accessor: (i) => i.customer_name ?? "" },
      { key: "source", accessor: (i) => i.source ?? "" },
      { key: "type", accessor: (i) => i.invoice_type },
      { key: "total_cents", accessor: (i) => i.total_cents },
      { key: "status", accessor: (i) => i.status ?? "" },
    ],
    default: { key: "invoice_date", dir: "desc" },
  },
};

// ── Expandable invoice row ────────────────────────────────────────────────────

function InvoiceExpandableRow({
  inv,
  accounts,
  batches,
  onSaveLineItem,
  onBatchChanged,
  onToggleAccept,
}: {
  inv: InvoiceRow;
  accounts: CoARef[];
  batches: BrewBatch[];
  onSaveLineItem: (id: string, patch: Record<string, string | null>) => Promise<void>;
  onBatchChanged: () => void;
  onToggleAccept: (id: string, accepted: boolean) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const linkCount = (inv.invoice_batch_links as unknown as { count: number }[])[0]?.count ?? 0;
  const lineItems = inv.invoice_line_items ?? [];
  const mappedCount = lineItems.filter((li) => li.chart_of_accounts_id).length;

  return (
    <>
      <tr
        className="border-t border-line/40 hover:bg-surface-mid/20 cursor-pointer"
        onClick={() => setExpanded((e) => !e)}>
        <td className="px-4 py-2 w-6">
          <span className="text-faint text-[10px]">{expanded ? "▾" : "▸"}</span>
        </td>
        <td className="px-4 py-2 font-mono text-accent">
          {inv.invoice_number ?? inv.square_invoice_id}
        </td>
        <td className="px-4 py-2 text-secondary">{fmtDate(inv.invoice_date)}</td>
        <td className="px-4 py-2 text-body">
          {inv.contract_brewing_partners?.company_name ?? inv.customer_name ?? "—"}
        </td>
        <td className="px-4 py-2">
          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${SOURCE_CLS[inv.source] ?? SOURCE_CLS.other}`}>
            {SOURCE_LABEL[inv.source] ?? inv.source}
          </span>
        </td>
        <td className="px-4 py-2">
          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${TYPE_CLS[(inv as InvoiceRow).invoice_type] ?? TYPE_CLS.standard}`}>
            {TYPE_LABEL[(inv as InvoiceRow).invoice_type] ?? (inv as InvoiceRow).invoice_type}
          </span>
        </td>
        <td className="px-4 py-2">
          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${STATUS_CLS[inv.status] ?? STATUS_CLS.unknown}`}>
            {inv.status}
          </span>
        </td>
        <td className="px-4 py-2">
          <div className="flex flex-col gap-1">
            {lineItems.length === 0
              ? <span className="text-disabled">—</span>
              : <MappingStatusPill mapped={mappedCount} total={lineItems.length} accepted={inv.unmapped_accepted} />}
            {lineItems.length > 0 && mappingState(mappedCount, lineItems.length, inv.unmapped_accepted) !== "mapped" && (
              <AcceptUnmappedButton
                accepted={inv.unmapped_accepted}
                onToggle={() => onToggleAccept(inv.id, !inv.unmapped_accepted)}
              />
            )}
          </div>
        </td>
        <td className="px-4 py-2 text-right font-mono text-strong tabular-nums">
          {fmtDollars(inv.total_cents)}
        </td>
        <td className="px-4 py-2 text-center">
          {linkCount > 0
            ? <span className="text-success font-medium">{linkCount}</span>
            : <span className="text-faint">—</span>}
        </td>
      </tr>

      {expanded && (
        <tr className="border-t border-line/20">
          <td colSpan={10} className="p-0">
            <div className="bg-canvas border-b border-line/60">
              {/* Line item headers */}
              <div className={`${LINE_GRID_COLS} px-10 py-1.5 bg-surface/40 text-[10px] text-faint uppercase tracking-wider`}>
                <span>Line item</span>
                <span>Description</span>
                <span className="text-right">Qty</span>
                <span className="text-right">Unit</span>
                <span className="text-right">Disc</span>
                <span className="text-right">Total</span>
                <span>GL Account</span>
              </div>
              {lineItems.length === 0
                ? <p className="px-10 py-3 text-xs text-faint italic">No line items</p>
                : lineItems
                    .slice()
                    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
                    .map((li) => (
                      <InvoiceLineItemRow
                        key={li.id}
                        item={li}
                        accounts={accounts}
                        onSave={onSaveLineItem}
                      />
                    ))}
              {(inv.discount_cents ?? 0) > 0 && (
                <div className={`${LINE_GRID_COLS} px-10 py-1 text-[11px] text-secondary`}>
                  <span className="col-span-5 text-right">Invoice discount</span>
                  <span className="text-right font-mono tabular-nums">{formatCurrencyCents(inv.discount_cents!)}</span>
                  <span />
                </div>
              )}
              {(inv.tax_cents ?? 0) > 0 && (
                <div className={`${LINE_GRID_COLS} px-10 py-1 text-[11px] text-secondary`}>
                  <span className="col-span-5 text-right">Tax</span>
                  <span className="text-right font-mono tabular-nums">{formatCurrencyCents(inv.tax_cents!)}</span>
                  <span />
                </div>
              )}
              <BatchLinkEditor invoiceId={inv.id} batches={batches} onChanged={onBatchChanged} />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function InvoiceLineItemRow({
  item,
  accounts,
  onSave,
}: {
  item: InvoiceLineItemRow;
  accounts: CoARef[];
  onSave: (id: string, patch: Record<string, string | null>) => Promise<void>;
}) {
  const [coaId,  setCoaId]  = useState<string | null>(item.chart_of_accounts_id);
  const [saving, setSaving] = useState(false);

  async function save(patch: Record<string, string | null>) {
    setSaving(true);
    await onSave(item.id, patch);
    setSaving(false);
  }

  async function handleCoaChange(id: string | null) { setCoaId(id); await save({ chart_of_accounts_id: id }); }

  return (
    <div className="border-t border-line/30 hover:bg-surface/20 transition-colors">
      {/* Main row */}
      <div className={`${LINE_GRID_COLS} px-10 py-2 text-xs items-start`}>
        <div className="min-w-0 pt-0.5">
          <span className="text-secondary truncate block">
            {item.line_item_name
              ? item.line_item_name + (item.variation_name ? ` — ${item.variation_name}` : "")
              : item.description}
          </span>
        </div>
        <span className={item.note ? "text-body truncate block pt-0.5" : "text-faint truncate block pt-0.5"}>
          {item.note ?? "—"}
        </span>
        <span className="text-faint text-right tabular-nums pt-0.5">{item.quantity ?? 1}×</span>
        <span className="text-muted text-right tabular-nums font-mono pt-0.5">
          {item.unit_price_cents ? formatCurrencyCents(item.unit_price_cents) : "—"}
        </span>
        <span className="text-muted text-right tabular-nums font-mono pt-0.5">
          {item.discount_cents ? formatCurrencyCents(item.discount_cents) : "—"}
        </span>
        <span className="text-body text-right tabular-nums font-mono pt-0.5">
          {formatCurrencyCents(item.net_sales_cents ?? item.total_cents)}
        </span>
        <div className="flex items-center gap-2">
          <AccountSelect value={coaId} accounts={accounts} onChange={handleCoaChange} className="w-full max-w-[300px]" />
          {saving && <span className="text-[10px] text-faint animate-pulse shrink-0">…</span>}
        </div>
      </div>
    </div>
  );
}


// ── Batch types ───────────────────────────────────────────────────────────────

interface BrewBatch {
  id: string;
  batch_number: string | null;
  beer_name: string;
  planned_brew_date: string | null;
}

interface BatchLink {
  id: string;
  note: string | null;
  created_at: string;
  brew_batches: { id: string; beer_name: string; batch_number: string | null; planned_brew_date: string | null } | null;
}

// ── Batch link editor (shown in expanded invoice row) ─────────────────────────

function BatchLinkEditor({
  invoiceId,
  batches,
  onChanged,
}: {
  invoiceId: string;
  batches: BrewBatch[];
  onChanged: () => void;
}) {
  const [links, setLinks] = useState<BatchLink[]>([]);
  const [loadingLinks, setLoadingLinks] = useState(true);
  const [selectedBatch, setSelectedBatch] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  useEffect(() => {
    setLoadingLinks(true); // eslint-disable-line react-hooks/set-state-in-effect
    fetch(`/api/finance/ledger/invoice-batch-links?invoice_id=${invoiceId}`)
      .then((r) => r.json())
      .then((d) => setLinks(Array.isArray(d) ? d : []))
      .finally(() => setLoadingLinks(false));
  }, [invoiceId]);

  async function handleAdd() {
    if (!selectedBatch) return;
    setAdding(true); setAddError(null);
    const res = await fetch("/api/finance/ledger/invoice-batch-links", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invoice_id: invoiceId, batch_id: selectedBatch }),
    });
    if (!res.ok) {
      const d = await res.json();
      setAddError(d.error ?? "Failed to link");
    } else {
      const link = await res.json() as BatchLink;
      setLinks((prev) => [link, ...prev]);
      setSelectedBatch("");
      onChanged();
    }
    setAdding(false);
  }

  async function handleRemove(linkId: string) {
    await fetch(`/api/finance/ledger/invoice-batch-links/${linkId}`, { method: "DELETE" });
    setLinks((prev) => prev.filter((l) => l.id !== linkId));
    onChanged();
  }

  const linkedBatchIds = new Set(links.map((l) => l.brew_batches?.id).filter(Boolean));
  const availableBatches = batches.filter((b) => !linkedBatchIds.has(b.id));

  return (
    <div className="px-10 py-3 border-t border-line/40 bg-canvas/40">
      <div className="text-[10px] text-muted uppercase tracking-wider mb-2">Batch Links</div>
      {loadingLinks ? (
        <p className="text-xs text-faint">Loading…</p>
      ) : (
        <>
          {links.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2">
              {links.map((link) => (
                <div key={link.id} className="flex items-center gap-1.5 bg-surface-mid border border-line-strong rounded px-2 py-1 text-xs">
                  <span className="text-body">
                    {link.brew_batches?.batch_number != null ? `#${link.brew_batches.batch_number} · ` : ""}
                    {link.brew_batches?.beer_name ?? "Unknown batch"}
                  </span>
                  <button onClick={() => handleRemove(link.id)}
                    className="text-faint hover:text-danger transition-colors ml-1">×</button>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2 flex-wrap">
            <select value={selectedBatch} onChange={(e) => setSelectedBatch(e.target.value)}
              className="inp-sm min-w-[200px] w-auto">
              <option value="">Select a batch…</option>
              {availableBatches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.batch_number != null ? `#${b.batch_number} · ` : ""}{b.beer_name}
                  {b.planned_brew_date ? ` (${b.planned_brew_date.slice(0, 7)})` : ""}
                </option>
              ))}
            </select>
            <button onClick={handleAdd} disabled={!selectedBatch || adding}
              className="btn-secondary">
              {adding ? "Linking…" : "Link"}
            </button>
            {addError && <span className="text-xs text-danger">{addError}</span>}
          </div>
        </>
      )}
    </div>
  );
}

// ── Invoice sync result shape ──────────────────────────────────────────────────

interface InvoiceSyncResult { synced: number; updated: number; total: number; errors?: string[] }

export default function InvoicesPage() {
  const [{ from, to }, setRange] = useState(() => defaultYearRange());
  const [source,     setSource] = useState<"all" | "square" | "quickbooks">("all");
  const [accounts,     setAccounts]     = useState<CoARef[]>([]);
  const [batches,      setBatches]      = useState<BrewBatch[]>([]);
  const [showVoided,   setShowVoided]   = useState(false);
  useEffect(() => {
    fetch("/api/finance/chart-of-accounts")
      .then((r) => r.json())
      .then((d: CoARef[]) => setAccounts(Array.isArray(d) ? d : []));
    fetch("/api/production/batches")
      .then((r) => r.json())
      .then((d: { id: string; batch_number: string | null; beer_name: string; planned_brew_date: string | null }[]) => {
        if (Array.isArray(d)) {
          setBatches(d.map((b) => ({ id: b.id, batch_number: b.batch_number, beer_name: b.beer_name, planned_brew_date: b.planned_brew_date })));
        }
      });
  }, []);

  async function handleAutoMap(): Promise<{ mapped: number }> {
    const res = await fetch(`/api/finance/ledger/invoices/auto-map?year=${new Date(to).getFullYear()}`, { method: "POST" });
    const json = await res.json();
    if (json.mapped > 0) refetch();
    return json;
  }

  async function handleSaveLineItem(id: string, patch: Record<string, string | null>) {
    await fetch("/api/finance/ledger/invoice-line-items", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...patch }),
    });
    refetch();
  }

  async function handleToggleAccept(id: string, accepted: boolean) {
    await fetch("/api/finance/ledger/invoices", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, unmapped_accepted: accepted }),
    });
    refetch();
  }

  const params = new URLSearchParams({ from, to });
  if (source !== "all") params.set("source", source);

  const { data: raw, isFetching, error, refetch } = useQuery({
    queryKey: queryKeys.finance.ledgerInvoices(`${from}_${to}`, source),
    queryFn:  () => fetchJson<InvoiceRow[]>(`/api/finance/ledger/invoices?${params}`),
  });

  // Client-side status + type + mapping filter + sort (URL-synced hook).
  // `from`/`to`/`source` stay local — they drive the useQuery key/params above.
  const { rows: hookRows, search, filters, sort, setSearch, setFilter, toggleSort, reset, activeCount } =
    useTableControls(raw ?? [], INVOICE_CONTROLS);

  // Voided handling stays a local toggle: hide voided rows unless the toggle is
  // on OR the status filter explicitly selects "voided".
  const invoices = useMemo(() => {
    const hideVoided = !showVoided && !(filters.status ?? []).includes("voided");
    return hideVoided ? hookRows.filter((i) => i.status !== "voided") : hookRows;
  }, [hookRows, showVoided, filters.status]);

  // Summary stats
  const totalValue    = invoices.reduce((s, i) => s + i.total_cents, 0);
  const openValue     = invoices.filter((i) => i.status === "open").reduce((s, i) => s + i.total_cents, 0);
  const unlinkedCount = invoices.filter((i) => (i.invoice_batch_links as unknown as { count: number }[])[0]?.count === 0).length;

  return (
    <>
      <div className="shrink-0 px-4 sm:px-6 pt-4 pb-4 border-b border-line">
        <FilterBar activeCount={activeCount} onClear={reset}>
          <SearchInput
            value={search.q ?? ""}
            onChange={(v) => setSearch("q", v)}
            placeholder="Search invoice # or customer…"
          />
          <DateRangeFilter from={from} to={to} onChange={(f, t) => setRange({ from: f, to: t })} />
          {/* source stays a fetch param (drives the useQuery key) */}
          <FilterSelect
            label="Source"
            allLabel="All sources"
            options={[
              { value: "square", label: "Square" },
              { value: "quickbooks", label: "QuickBooks" },
            ]}
            value={source === "all" ? [] : [source]}
            onChange={(v) => setSource((v[0] as typeof source) ?? "all")}
          />
          <FilterSelect
            label="Status"
            allLabel="All statuses"
            options={[
              { value: "open", label: "Open" },
              { value: "paid", label: "Paid" },
              { value: "partial", label: "Partial" },
              { value: "draft", label: "Draft" },
              { value: "voided", label: "Voided" },
            ]}
            value={filters.status ?? []}
            onChange={(v) => setFilter("status", v)}
          />
          <FilterSelect
            label="Type"
            allLabel="All types"
            options={[
              { value: "standard", label: "Standard" },
              { value: "allocation_deposit", label: "Deposit" },
              { value: "export_invoice", label: "Export" },
            ]}
            value={filters.type ?? []}
            onChange={(v) => setFilter("type", v)}
          />
          <MappingFilter
            value={(filters.mapping?.[0] as MappingFilterValue) ?? "all"}
            onChange={(v) => setFilter("mapping", v === "all" ? [] : [v])}
          />
          <button
            onClick={() => setShowVoided((v) => !v)}
            className={`btn-secondary whitespace-nowrap ${showVoided ? "text-body" : "text-faint"}`}>
            {showVoided ? "Hide voided" : "Show voided"}
          </button>
          <SyncPanel<InvoiceSyncResult>
            year={new Date(to).getFullYear()}
            storageKey="tpb-invoices-last-sync"
            label="from Square"
            buildEndpoint={({ year }) => `/api/finance/ledger/sync-square?year=${year}`}
            onSynced={() => refetch()}
            renderResult={(r) => (
              <>
                {r.synced > 0 && <span className="text-success mr-1">{r.synced} new</span>}
                {r.updated > 0 && <span className="text-secondary mr-1">{r.updated} updated</span>}
                {r.total === 0 && <span className="text-faint">No invoices found</span>}
                {r.errors?.length ? <span className="text-danger">{r.errors.length} errors</span> : null}
              </>
            )}
          />
          <AutoMapButton key={`${from}_${to}`} onRun={handleAutoMap} />
        </FilterBar>
      </div>

      {/* Summary bar */}
      {!isFetching && invoices.length > 0 && (
        <SummaryStatBar
          stats={[
            { label: "Invoices", value: invoices.length },
            { label: "Total value", value: formatCurrencyCents(totalValue, 0) },
            ...(openValue > 0 ? [{ label: "Open", value: formatCurrencyCents(openValue, 0), tone: "accent" as const }] : []),
            ...(unlinkedCount > 0 ? [{ label: "Unlinked to batch", value: unlinkedCount, tone: "secondary" as const }] : []),
          ]}
        />
      )}

      {error && (
        <Banner className="mx-6 mt-4">
          {error instanceof Error ? error.message : "Failed to load"}
        </Banner>
      )}

      {/* Table */}
      <div className="flex-1 overflow-auto px-4 sm:px-6 py-4">
        <LedgerTable
          head={
            <>
              <Th className="w-6" />
              <SortableTh label="Invoice #" sortKey="invoice_number" sort={sort} onSort={toggleSort} />
              <SortableTh label="Date" sortKey="invoice_date" sort={sort} onSort={toggleSort} />
              <SortableTh label="Customer" sortKey="customer_name" sort={sort} onSort={toggleSort} />
              <SortableTh label="Source" sortKey="source" sort={sort} onSort={toggleSort} />
              <SortableTh label="Type" sortKey="type" sort={sort} onSort={toggleSort} />
              <SortableTh label="Status" sortKey="status" sort={sort} onSort={toggleSort} />
              <Th label="GL / Categories" />
              <SortableTh label="Total" sortKey="total_cents" sort={sort} onSort={toggleSort} align="right" />
              <Th label="Batches" align="center" />
            </>
          }>
          {isFetching ? (
            <tr><td colSpan={10} className="px-4 py-8 text-center text-faint">Loading…</td></tr>
          ) : invoices.length === 0 ? (
            <tr><td colSpan={10} className="px-4 py-8 text-center text-faint">
              No invoices found.
            </td></tr>
          ) : (
            invoices.map((inv) => (
              <InvoiceExpandableRow
                key={inv.id}
                inv={inv}
                accounts={accounts}
                batches={batches}
                onSaveLineItem={handleSaveLineItem}
                onBatchChanged={() => refetch()}
                onToggleAccept={handleToggleAccept}
              />
            ))
          )}
        </LedgerTable>
      </div>
    </>
  );
}
