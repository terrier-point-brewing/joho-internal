"use client";
import { useState, useEffect } from "react";
import { formatCurrencyCents } from "@/lib/format";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { fetchJson } from "@/app/production/hooks/queries";
import type { Invoice, InvoiceType } from "@/types/finance";
import Banner from "@/app/components/ui/Banner";
import AccountSelect from "../../AccountSelect";
import SyncPanel from "../components/SyncPanel";
import MappingFilter from "../components/MappingFilter";
import MappingStatusPill from "../components/MappingStatusPill";
import AutoMapButton from "../components/AutoMapButton";
import YearSelect from "../components/YearSelect";
import SummaryStatBar from "../components/SummaryStatBar";
import { LedgerTable, SortableTh, Th, useTableSort } from "../components/LedgerTable";
import { matchesMappingFilter, type MappingFilterValue } from "@/lib/finance/mappingStatus";
import {
  INVOICE_STATUS_CLS, INVOICE_SOURCE_LABEL, INVOICE_SOURCE_CLS,
  INVOICE_TYPE_LABEL, INVOICE_TYPE_CLS, DEPOSIT_CATEGORY_CLS,
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
  category: string | null;
  quantity: number | null;
  unit_price_cents: number;
  total_cents: number;
  variation_name: string | null;
  chart_of_accounts_id: string | null;
  bs_chart_of_accounts_id: string | null;
  pl_chart_of_accounts_id: string | null;
  delivery_invoice_id: string | null;
  account_mode: "force_bs" | "force_pl" | null;
  chart_of_accounts: CoARef | null;
}

interface InvoiceRow extends Omit<Invoice, "invoice_line_items"> {
  invoice_line_items: InvoiceLineItemRow[];
  invoice_batch_links: { count: number }[];
  contract_brewing_partners: { company_name: string } | null;
  invoice_type: InvoiceType;
  allocation_id: string | null;
}

// ── Expandable invoice row ────────────────────────────────────────────────────

interface InvoiceSummary { id: string; invoice_number: string | null; square_invoice_id: string | null; invoice_date: string | null; customer_name: string | null; status: string }

function InvoiceExpandableRow({
  inv,
  accounts,
  batches,
  allInvoices,
  onSaveLineItem,
  onBatchChanged,
}: {
  inv: InvoiceRow;
  accounts: CoARef[];
  batches: BrewBatch[];
  allInvoices: InvoiceSummary[];
  onSaveLineItem: (id: string, patch: Record<string, string | null>) => Promise<void>;
  onBatchChanged: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const linkCount = (inv.invoice_batch_links as unknown as { count: number }[])[0]?.count ?? 0;
  const lineItems = inv.invoice_line_items ?? [];
  const mappedCount = lineItems.filter((li) => li.chart_of_accounts_id || li.bs_chart_of_accounts_id).length;
  const missingDelivery = lineItems.some((li) => li.bs_chart_of_accounts_id && !li.delivery_invoice_id);

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
              : <MappingStatusPill mapped={mappedCount} total={lineItems.length} />}
            {missingDelivery && (
              <span className="text-[10px] text-accent">⚠ deposit missing delivery</span>
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
              <div className="grid grid-cols-[minmax(0,2fr)_60px_80px_80px_minmax(0,1fr)] gap-3 px-10 py-1.5 bg-surface/40 text-[10px] text-faint uppercase tracking-wider">
                <span>Description</span>
                <span className="text-right">Qty</span>
                <span className="text-right">Unit Price</span>
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
                        allInvoices={allInvoices.filter((i) => i.id !== inv.id)}
                        onSave={onSaveLineItem}
                      />
                    ))}
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
  allInvoices,
  onSave,
}: {
  item: InvoiceLineItemRow;
  accounts: CoARef[];
  allInvoices: InvoiceSummary[];
  onSave: (id: string, patch: Record<string, string | null>) => Promise<void>;
}) {
  const [coaId,   setCoaId]   = useState<string | null>(item.chart_of_accounts_id);
  const [bsId,    setBsId]    = useState<string | null>(item.bs_chart_of_accounts_id);
  const [plId,    setPlId]    = useState<string | null>(item.pl_chart_of_accounts_id);
  const [delivId, setDelivId] = useState<string | null>(item.delivery_invoice_id);
  const [saving,  setSaving]  = useState(false);
  const isDeposit = !!(bsId || plId);

  async function save(patch: Record<string, string | null>) {
    setSaving(true);
    await onSave(item.id, patch);
    setSaving(false);
  }

  async function handleCoaChange(id: string | null) { setCoaId(id); await save({ chart_of_accounts_id: id }); }
  async function handleBsChange(id: string | null)  { setBsId(id);  await save({ bs_chart_of_accounts_id: id }); }
  async function handlePlChange(id: string | null)  { setPlId(id);  await save({ pl_chart_of_accounts_id: id }); }
  async function handleDelivChange(id: string | null) { setDelivId(id); await save({ delivery_invoice_id: id }); }

  // Determine effective account for display hint
  const deliveryInv = allInvoices.find((i) => i.id === delivId);
  const deliveryPaid = deliveryInv?.status === "paid";

  return (
    <div className="border-t border-line/30 hover:bg-surface/20 transition-colors">
      {/* Main row */}
      <div className="grid grid-cols-[minmax(0,2fr)_60px_80px_80px_minmax(0,1fr)] gap-3 px-10 py-2 text-xs items-start">
        <div className="min-w-0 pt-0.5">
          <span className="text-secondary truncate block">{item.description}</span>
          {item.variation_name && <span className="text-[10px] text-faint">{item.variation_name}</span>}
          {isDeposit && (
            <span className={`inline-block mt-0.5 ml-1 px-1 py-0.5 rounded text-[10px] font-medium ${DEPOSIT_CATEGORY_CLS}`}>
              deposit
            </span>
          )}
        </div>
        <span className="text-faint text-right tabular-nums pt-0.5">{item.quantity ?? 1}×</span>
        <span className="text-muted text-right tabular-nums font-mono pt-0.5">
          {item.unit_price_cents ? formatCurrencyCents(item.unit_price_cents) : "—"}
        </span>
        <span className="text-body text-right tabular-nums font-mono pt-0.5">
          {formatCurrencyCents(item.total_cents)}
        </span>
        <div className="flex flex-col gap-1.5">
          {!isDeposit && (
            <div className="flex items-center gap-2">
              <AccountSelect value={coaId} accounts={accounts} onChange={handleCoaChange} className="w-full max-w-[300px]" />
              {saving && <span className="text-[10px] text-faint animate-pulse shrink-0">…</span>}
            </div>
          )}
          {isDeposit && (
            <div className="flex flex-col gap-1.5">
              {/* BS account — violet = balance-sheet recognition (data category, no token) */}
              <div className="flex items-center gap-1.5">
                <span className={`text-[10px] font-medium px-1 py-0.5 rounded shrink-0 ${!deliveryPaid ? "bg-violet-900/60 text-violet-300" : "bg-surface-mid text-muted"}`}>BS</span>
                <AccountSelect value={bsId} accounts={accounts} onChange={handleBsChange} className="w-full max-w-[300px]" />
              </div>
              {/* PL account — green = P&L recognition (success token) */}
              <div className="flex items-center gap-1.5">
                <span className={`text-[10px] font-medium px-1 py-0.5 rounded shrink-0 ${deliveryPaid ? "bg-success-surface/60 text-success" : "bg-surface-mid text-muted"}`}>P&L</span>
                <AccountSelect value={plId} accounts={accounts} onChange={handlePlChange} className="w-full max-w-[300px]" />
              </div>
              {/* Delivery invoice */}
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-faint shrink-0">delivery</span>
                <select
                  value={delivId ?? ""}
                  onChange={(e) => handleDelivChange(e.target.value || null)}
                  className="inp-sm flex-1">
                  <option value="">— no delivery invoice —</option>
                  {allInvoices.map((inv) => (
                    <option key={inv.id} value={inv.id}>
                      {inv.invoice_number ?? inv.square_invoice_id ?? inv.id.slice(0, 8)}
                      {inv.invoice_date ? ` · ${inv.invoice_date.slice(0, 7)}` : ""}
                      {inv.customer_name ? ` · ${inv.customer_name}` : ""}
                      {inv.status === "paid" ? " ✓" : ""}
                    </option>
                  ))}
                </select>
              </div>
              {/* Warning */}
              {!delivId && (
                <p className="text-[10px] text-accent-emphasis/80">No delivery invoice linked — showing as Balance Sheet</p>
              )}
              {saving && <span className="text-[10px] text-faint animate-pulse">…</span>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


// ── Batch types ───────────────────────────────────────────────────────────────

interface BrewBatch {
  id: string;
  batch_number: number | null;
  beer_name: string;
  planned_brew_date: string | null;
}

interface BatchLink {
  id: string;
  note: string | null;
  created_at: string;
  brew_batches: { id: string; beer_name: string; batch_number: number | null; planned_brew_date: string | null } | null;
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

type SortKey = "invoice_number" | "invoice_date" | "customer_name" | "source" | "type" | "total_cents" | "status";

export default function InvoicesPage() {
  const currentYear = new Date().getFullYear();
  const [year,       setYear]   = useState(currentYear);
  const [source,     setSource] = useState<"all" | "square" | "quickbooks">("all");
  const [status,     setStatus] = useState<"all" | "open" | "paid" | "partial" | "voided" | "unknown">("all");
  const [typeFilter,    setTypeFilter]    = useState<"all" | InvoiceType>("all");
  const [mappingFilter, setMappingFilter] = useState<MappingFilterValue>("all");
  const sort = useTableSort<SortKey>("invoice_date");
  const [accounts,     setAccounts]     = useState<CoARef[]>([]);
  const [batches,      setBatches]      = useState<BrewBatch[]>([]);
  const [showVoided,   setShowVoided]   = useState(false);
  useEffect(() => {
    fetch("/api/finance/chart-of-accounts")
      .then((r) => r.json())
      .then((d: CoARef[]) => setAccounts(Array.isArray(d) ? d : []));
    fetch("/api/production/batches")
      .then((r) => r.json())
      .then((d: { id: string; batch_number: number | null; beer_name: string; planned_brew_date: string | null }[]) => {
        if (Array.isArray(d)) {
          setBatches(d.map((b) => ({ id: b.id, batch_number: b.batch_number, beer_name: b.beer_name, planned_brew_date: b.planned_brew_date })));
        }
      });
  }, []);

  async function handleAutoMap(): Promise<{ mapped: number }> {
    const res = await fetch(`/api/finance/ledger/invoices/auto-map?year=${year}`, { method: "POST" });
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

  const params = new URLSearchParams({ year: String(year) });
  if (source !== "all") params.set("source", source);

  const { data: raw, isFetching, error, refetch } = useQuery({
    queryKey: queryKeys.finance.ledgerInvoices(year, source),
    queryFn:  () => fetchJson<InvoiceRow[]>(`/api/finance/ledger/invoices?${params}`),
  });

  // Client-side status + type + mapping filter + sort
  const invoices = (raw ?? [])
    .filter((inv) => showVoided || status === "voided" || inv.status !== "voided")
    .filter((inv) => status === "all" || inv.status === status)
    .filter((inv) => typeFilter === "all" || (inv as InvoiceRow).invoice_type === typeFilter)
    .filter((inv) => {
      const items = (inv as InvoiceRow).invoice_line_items ?? [];
      const mapped = items.filter((li) => li.chart_of_accounts_id || li.bs_chart_of_accounts_id).length;
      return matchesMappingFilter(mappingFilter, mapped, items.length);
    })
    .sort((a, b) => {
      let diff = 0;
      if (sort.key === "invoice_number") diff = (a.invoice_number ?? a.square_invoice_id ?? "").localeCompare(b.invoice_number ?? b.square_invoice_id ?? "");
      else if (sort.key === "invoice_date") diff = (a.invoice_date ?? "").localeCompare(b.invoice_date ?? "");
      else if (sort.key === "customer_name") diff = (a.customer_name ?? "").localeCompare(b.customer_name ?? "");
      else if (sort.key === "source") diff = a.source.localeCompare(b.source);
      else if (sort.key === "type") diff = ((a as InvoiceRow).invoice_type).localeCompare((b as InvoiceRow).invoice_type);
      else if (sort.key === "total_cents") diff = a.total_cents - b.total_cents;
      else if (sort.key === "status") diff = a.status.localeCompare(b.status);
      return sort.asc ? diff : -diff;
    });

  // Summary stats
  const totalValue    = invoices.reduce((s, i) => s + i.total_cents, 0);
  const openValue     = invoices.filter((i) => i.status === "open").reduce((s, i) => s + i.total_cents, 0);
  const unlinkedCount = invoices.filter((i) => (i.invoice_batch_links as unknown as { count: number }[])[0]?.count === 0).length;

  return (
    <>
      <div className="shrink-0 px-4 sm:px-6 pt-4 pb-4 border-b border-line">
        <div className="flex flex-wrap items-center gap-2">
          <YearSelect year={year} onChange={setYear} />
          <select value={source} onChange={(e) => setSource(e.target.value as typeof source)}
            className="inp-sm w-auto">
            <option value="all">All sources</option>
            <option value="square">Square</option>
            <option value="quickbooks">QuickBooks</option>
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}
            className="inp-sm w-auto">
            <option value="all">All statuses</option>
            <option value="open">Open</option>
            <option value="paid">Paid</option>
            <option value="partial">Partial</option>
            <option value="draft">Draft</option>
            <option value="voided">Voided</option>
          </select>
          <button
            onClick={() => setShowVoided((v) => !v)}
            className={`btn-secondary whitespace-nowrap ${showVoided ? "text-body" : "text-faint"}`}>
            {showVoided ? "Hide voided" : "Show voided"}
          </button>
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as typeof typeFilter)}
            className="inp-sm w-auto">
            <option value="all">All types</option>
            <option value="standard">Standard</option>
            <option value="allocation_deposit">Deposit invoices</option>
            <option value="export_invoice">Export invoices</option>
          </select>
          <MappingFilter value={mappingFilter} onChange={setMappingFilter} />
          <SyncPanel<InvoiceSyncResult>
            year={year}
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
          <AutoMapButton key={year} onRun={handleAutoMap} />
        </div>
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
              <SortableTh label="Invoice #" sortKey="invoice_number" sort={sort} />
              <SortableTh label="Date" sortKey="invoice_date" sort={sort} />
              <SortableTh label="Customer" sortKey="customer_name" sort={sort} />
              <SortableTh label="Source" sortKey="source" sort={sort} />
              <SortableTh label="Type" sortKey="type" sort={sort} />
              <SortableTh label="Status" sortKey="status" sort={sort} />
              <Th label="GL / Categories" />
              <SortableTh label="Total" sortKey="total_cents" sort={sort} align="right" />
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
                allInvoices={(raw ?? []).map((i) => ({ id: i.id, invoice_number: i.invoice_number ?? null, square_invoice_id: i.square_invoice_id ?? null, invoice_date: i.invoice_date ?? null, customer_name: i.customer_name ?? null, status: i.status }))}
                onSaveLineItem={handleSaveLineItem}
                onBatchChanged={() => refetch()}
              />
            ))
          )}
        </LedgerTable>
      </div>
    </>
  );
}
