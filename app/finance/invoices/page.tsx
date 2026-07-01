"use client";
import { useState, useEffect } from "react";
import { formatCurrencyCents } from "@/lib/format";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { fetchJson } from "@/app/production/hooks/queries";
import type { Invoice, InvoiceType } from "@/types/finance";
import FinanceNav from "../FinanceNav";
import TransactionsNav from "../transactions/TransactionsNav";
import PageHeader from "@/app/components/PageHeader";
import Banner from "@/app/components/ui/Banner";
import AccountSelect from "../AccountSelect";
import {
  INVOICE_STATUS_CLS, INVOICE_SOURCE_LABEL, INVOICE_SOURCE_CLS,
  INVOICE_TYPE_LABEL, INVOICE_TYPE_CLS, DEPOSIT_CATEGORY_CLS,
} from "../lib/categoryColors";

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
  const allMapped = lineItems.length > 0 && mappedCount === lineItems.length;
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
              : allMapped
                ? <span className="text-[10px] text-success">✓ all mapped</span>
                : mappedCount > 0
                  ? <span className="text-[10px] text-accent-emphasis">{mappedCount}/{lineItems.length} mapped</span>
                  : <span className="text-[10px] text-faint">unmapped</span>}
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
              className="btn-sm">
              {adding ? "Linking…" : "Link"}
            </button>
            {addError && <span className="text-xs text-danger">{addError}</span>}
          </div>
        </>
      )}
    </div>
  );
}

// ── Invoice sync panel ─────────────────────────────────────────────────────────

const INVOICE_LAST_SYNC_KEY = "tpb-invoices-last-sync";

function daysSince(isoStr: string): number {
  return Math.floor((Date.now() - new Date(isoStr).getTime()) / 86_400_000);
}

function InvoiceSyncPanel({ year, onSynced }: { year: number; onSynced: () => void }) {
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState<{ synced: number; updated: number; total: number; errors?: string[] } | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<string | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem(INVOICE_LAST_SYNC_KEY);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (stored) setLastSync(stored);
  }, []);

  async function handleSync() {
    setSyncing(true); setSyncError(null); setResult(null);
    try {
      const res = await fetch(`/api/finance/ledger/sync-square?year=${year}`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) { setSyncError(json.error ?? "Sync failed"); return; }
      setResult(json);
      const now = new Date().toISOString();
      localStorage.setItem(INVOICE_LAST_SYNC_KEY, now);
      setLastSync(now);
      onSynced();
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : "Network error");
    } finally { setSyncing(false); }
  }

  const days = lastSync != null ? daysSince(lastSync) : null;

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {days != null && (
        <span className={`text-xs ${days >= 7 ? "text-accent" : "text-muted"}`}>
          Last sync: {days === 0 ? "today" : `${days}d ago`}
        </span>
      )}
      <button onClick={handleSync} disabled={syncing}
        className="btn-sm whitespace-nowrap">
        {syncing ? "Syncing invoices…" : "Sync from Square"}
      </button>
      {syncError && <span className="text-xs text-danger">{syncError}</span>}
      {result && (
        <span className="text-xs text-secondary">
          {result.synced > 0 && <span className="text-success mr-1">{result.synced} new</span>}
          {result.updated > 0 && <span className="text-secondary mr-1">{result.updated} updated</span>}
          {result.total === 0 && <span className="text-faint">No invoices found</span>}
          {result.errors?.length ? <span className="text-danger">{result.errors.length} errors</span> : null}
        </span>
      )}
    </div>
  );
}

type SortKey = "invoice_number" | "invoice_date" | "customer_name" | "source" | "type" | "total_cents" | "status";

function SortIcon({ k, sortKey, sortAsc }: { k: SortKey; sortKey: SortKey; sortAsc: boolean }) {
  return (
    <span className={`ml-1 ${sortKey === k ? "text-accent" : "text-disabled"}`}>
      {sortKey === k ? (sortAsc ? "↑" : "↓") : "↕"}
    </span>
  );
}

export default function InvoicesPage() {
  const currentYear = new Date().getFullYear();
  const [year,       setYear]   = useState(currentYear);
  const [source,     setSource] = useState<"all" | "square" | "quickbooks">("all");
  const [status,     setStatus] = useState<"all" | "open" | "paid" | "partial" | "voided" | "unknown">("all");
  const [typeFilter,    setTypeFilter]    = useState<"all" | InvoiceType>("all");
  const [mappingFilter, setMappingFilter] = useState<"all" | "mapped" | "partial" | "unmapped">("all");
  const [sortKey,    setSort]   = useState<SortKey>("invoice_date");
  const [sortAsc,    setSortAsc] = useState(false);
  const [accounts,     setAccounts]     = useState<CoARef[]>([]);
  const [batches,      setBatches]      = useState<BrewBatch[]>([]);
  const [showVoided,   setShowVoided]   = useState(false);
  const [autoMapping,  setAutoMapping]  = useState(false);
  const [autoMapResult, setAutoMapResult] = useState<{ mapped: number } | null>(null);
  const years = Array.from({ length: 5 }, (_, i) => currentYear - i);

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

  async function handleAutoMap() {
    setAutoMapping(true); setAutoMapResult(null);
    const res = await fetch(`/api/finance/ledger/invoices/auto-map?year=${year}`, { method: "POST" });
    const json = await res.json();
    setAutoMapResult(json);
    if (json.mapped > 0) refetch();
    setAutoMapping(false);
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
      if (mappingFilter === "all") return true;
      const items = (inv as InvoiceRow).invoice_line_items ?? [];
      if (items.length === 0) return mappingFilter === "unmapped";
      const mapped = items.filter((li) => li.chart_of_accounts_id || li.bs_chart_of_accounts_id).length;
      if (mappingFilter === "mapped")   return mapped === items.length;
      if (mappingFilter === "partial")  return mapped > 0 && mapped < items.length;
      if (mappingFilter === "unmapped") return mapped === 0;
      return true;
    })
    .sort((a, b) => {
      let diff = 0;
      if (sortKey === "invoice_number") diff = (a.invoice_number ?? a.square_invoice_id ?? "").localeCompare(b.invoice_number ?? b.square_invoice_id ?? "");
      else if (sortKey === "invoice_date") diff = (a.invoice_date ?? "").localeCompare(b.invoice_date ?? "");
      else if (sortKey === "customer_name") diff = (a.customer_name ?? "").localeCompare(b.customer_name ?? "");
      else if (sortKey === "source") diff = a.source.localeCompare(b.source);
      else if (sortKey === "type") diff = ((a as InvoiceRow).invoice_type).localeCompare((b as InvoiceRow).invoice_type);
      else if (sortKey === "total_cents") diff = a.total_cents - b.total_cents;
      else if (sortKey === "status") diff = a.status.localeCompare(b.status);
      return sortAsc ? diff : -diff;
    });

  function handleSort(key: SortKey) {
    if (sortKey === key) setSortAsc((v) => !v);
    else { setSort(key); setSortAsc(false); }
  }

  // Summary stats
  const totalValue    = invoices.reduce((s, i) => s + i.total_cents, 0);
  const openValue     = invoices.filter((i) => i.status === "open").reduce((s, i) => s + i.total_cents, 0);
  const unlinkedCount = invoices.filter((i) => (i.invoice_batch_links as unknown as { count: number }[])[0]?.count === 0).length;

  return (
    <div className="flex flex-col h-full bg-canvas text-primary">
      <FinanceNav mobile />
      {/* Header */}
      <div className="shrink-0 px-4 sm:px-6">
        <PageHeader
          title="Invoices"
          description="Square and QuickBooks invoices · map line items to GL accounts"
        />
      </div>
      <TransactionsNav />
      <div className="shrink-0 px-4 sm:px-6 pb-4 border-b border-line">
        <div className="flex flex-wrap items-center gap-2">
          <select value={year} onChange={(e) => setYear(Number(e.target.value))}
            className="inp-sm w-auto">
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
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
            className={`btn-sm whitespace-nowrap ${showVoided ? "text-body" : "text-faint"}`}>
            {showVoided ? "Hide voided" : "Show voided"}
          </button>
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as typeof typeFilter)}
            className="inp-sm w-auto">
            <option value="all">All types</option>
            <option value="standard">Standard</option>
            <option value="allocation_deposit">Deposit invoices</option>
            <option value="export_invoice">Export invoices</option>
          </select>
          <select value={mappingFilter} onChange={(e) => setMappingFilter(e.target.value as typeof mappingFilter)}
            className="inp-sm w-auto">
            <option value="all">All GL mappings</option>
            <option value="mapped">Fully mapped</option>
            <option value="partial">Partially mapped</option>
            <option value="unmapped">Unmapped</option>
          </select>
          <InvoiceSyncPanel year={year} onSynced={() => refetch()} />
          <div className="flex items-center gap-2">
            <button onClick={handleAutoMap} disabled={autoMapping}
              className="btn-sm whitespace-nowrap">
              {autoMapping ? "Mapping…" : "Auto-map all"}
            </button>
            {autoMapResult && (
              <span className="text-xs">
                {autoMapResult.mapped > 0
                  ? <span className="text-success">{autoMapResult.mapped} mapped</span>
                  : <span className="text-faint">Nothing to map</span>}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Summary bar */}
      {!isFetching && invoices.length > 0 && (
        <div className="shrink-0 flex flex-wrap items-center gap-4 sm:gap-6 px-4 sm:px-6 py-3 border-b border-line/60 bg-surface/30">
          <div>
            <span className="text-xs text-muted">Invoices </span>
            <span className="text-sm font-semibold text-strong">{invoices.length}</span>
          </div>
          <div>
            <span className="text-xs text-muted">Total value </span>
            <span className="text-sm font-semibold text-strong">{formatCurrencyCents(totalValue, 0)}</span>
          </div>
          {openValue > 0 && (
            <div>
              <span className="text-xs text-muted">Open </span>
              <span className="text-sm font-semibold text-accent">{formatCurrencyCents(openValue, 0)}</span>
            </div>
          )}
          {unlinkedCount > 0 && (
            <div>
              <span className="text-xs text-muted">Unlinked to batch </span>
              <span className="text-sm font-semibold text-secondary">{unlinkedCount}</span>
            </div>
          )}
        </div>
      )}

      {error && (
        <Banner className="mx-6 mt-4">
          {error instanceof Error ? error.message : "Failed to load"}
        </Banner>
      )}

      {/* Table */}
      <div className="flex-1 overflow-auto px-4 sm:px-6 py-4">
        <div className="bg-surface border border-line rounded-lg overflow-hidden">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-line">
                <th className="w-6 px-2" />
                <th className="px-4 py-2 text-left text-muted font-medium cursor-pointer select-none hover:text-body"
                  onClick={() => handleSort("invoice_number")}>
                  Invoice # <SortIcon k="invoice_number" sortKey={sortKey} sortAsc={sortAsc} />
                </th>
                <th className="px-4 py-2 text-left text-muted font-medium cursor-pointer select-none hover:text-body"
                  onClick={() => handleSort("invoice_date")}>
                  Date <SortIcon k="invoice_date" sortKey={sortKey} sortAsc={sortAsc} />
                </th>
                <th className="px-4 py-2 text-left text-muted font-medium cursor-pointer select-none hover:text-body"
                  onClick={() => handleSort("customer_name")}>
                  Customer <SortIcon k="customer_name" sortKey={sortKey} sortAsc={sortAsc} />
                </th>
                <th className="px-4 py-2 text-left text-muted font-medium cursor-pointer select-none hover:text-body"
                  onClick={() => handleSort("source")}>
                  Source <SortIcon k="source" sortKey={sortKey} sortAsc={sortAsc} />
                </th>
                <th className="px-4 py-2 text-left text-muted font-medium cursor-pointer select-none hover:text-body"
                  onClick={() => handleSort("type")}>
                  Type <SortIcon k="type" sortKey={sortKey} sortAsc={sortAsc} />
                </th>
                <th className="px-4 py-2 text-left text-muted font-medium cursor-pointer select-none hover:text-body"
                  onClick={() => handleSort("status")}>
                  Status <SortIcon k="status" sortKey={sortKey} sortAsc={sortAsc} />
                </th>
                <th className="px-4 py-2 text-left text-muted font-medium">GL / Categories</th>
                <th className="px-4 py-2 text-right text-muted font-medium cursor-pointer select-none hover:text-body"
                  onClick={() => handleSort("total_cents")}>
                  Total <SortIcon k="total_cents" sortKey={sortKey} sortAsc={sortAsc} />
                </th>
                <th className="px-4 py-2 text-center text-muted font-medium">Batches</th>
              </tr>
            </thead>
            <tbody>
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
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
