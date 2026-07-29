"use client";

import { useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson, useContractPartnersQuery } from "../hooks/queries";
import { queryKeys } from "@/lib/query-keys";
import InvoicePreviewModal from "./InvoicePreviewModal";
import { CHANNEL_COLOR } from "../lib/categoryColors";
import { fmtDateLong } from "@/lib/utils/formatting";
import { formatCurrency, formatNumber } from "@/lib/format";
import { localDateString } from "@/lib/utils/datetime";
import {
  rowReconcileState,
  worseReconcileState,
  type ReconcileState,
} from "@/lib/production/draftRecountState";
import { useTableControls } from "@/app/components/ui/useTableControls";
import FilterChips from "@/app/components/ui/FilterChips";
import SearchInput from "@/app/components/ui/SearchInput";
import FilterSelect from "@/app/components/ui/FilterSelect";
import FilterBar from "@/app/components/ui/FilterBar";
import type { ControlsConfig } from "@/lib/table/types";

interface ShipmentRow {
  id: string;
  shipment_id: string;
  recipe_id: string | null;
  channel: "taproom" | "distribution" | "contract_brewing" | "wholesale";
  recipient_id: string | null;
  recipient_name: string | null;
  variant_label: string;
  quantity: number;
  volume_bbl: number;
  total_excise_tax_usd: number;
  status: "invoice_required" | "unpaid" | "paid";
  invoice_id: string | null;
  invoice_number: string | null;
  source_ref: string | null;
  packaging_format: string | null;
  packaging_item_type: string | null;
  packaging_item_volume_fl_oz: number | null;
  packaging_item_name: string | null;
  created_at: string;
  brew_batches: { id: string; beer_name: string; batch_number: string } | null;
  /** Beer name off the recipe. Always present, including on batchless rows. */
  recipe_beer_name: string | null;
  /** Draft swap that booked barrel excise with no cold-storage stock to deduct. */
  is_phantom: boolean | null;
  /** Set once a phantom is resolved against a keg lot, or dismissed as stockless. */
  alert_acknowledged_at: string | null;
}

// Display status shown on the Shipments tab. "draft" is a UI-only state derived
// from a transaction that has an invoice_id but is still `invoice_required` in
// the DB — i.e. a Square draft invoice has been generated but not yet sent. The
// underlying tx status stays `invoice_required` (the `send` action depends on
// that), so this distinction lives entirely in the client.
type DisplayStatus = "invoice_required" | "draft" | "unpaid" | "paid";

function rowDisplayStatus(row: Pick<ShipmentRow, "invoice_id" | "status">): DisplayStatus {
  if (row.invoice_id && row.status === "invoice_required") return "draft";
  return row.status;
}

interface AllocationCredit {
  id: string;
  batch_number: string;
  quantity: number;
  volume_bbl: number;
  status: DisplayStatus;
  created_at: string;
}

interface GroupProductRow {
  recipe_id: string | null;
  beer_name: string;
  variant_label: string;
  packaging_category: string;
  /** Plural noun for allocation counts ("kegs", "cans", "units"). */
  unit_label: string;
  packaging_sort_key: [number, number, number];
  channel: "taproom" | "distribution" | "contract_brewing" | "wholesale";
  created_at: string;
  total_quantity: number;
  total_volume_bbl: number;
  total_excise_tax_usd: number;
  /** True when any constituent row came from a restock-driven draft keg swap. */
  isDraftRecount: boolean;
  /** Worst reconciliation state across the constituent rows. */
  reconcileState: ReconcileState;
  allocations: AllocationCredit[];
}

// Groups invoiced rows by invoice_id, partner shipments by shipment_id, and
// taproom consumption by day (taproom is internal — never invoiced, and a day's
// sync may span several shipment_ids we want collapsed into one card).
interface InvoiceGroup {
  key: string;
  invoice_id: string | null;
  invoice_number: string | null;
  recipient_id: string | null;
  recipient_name: string | null;
  status: DisplayStatus;
  /** Set for taproom day-groups; drives the date-labelled header. */
  isTaproom: boolean;
  day: string | null;
  products: GroupProductRow[];
}

const DRAFT_RECOUNT_PREFIX = "sqtransfer:";

function isDraftRecountRef(sourceRef: string | null): boolean {
  return !!sourceRef && sourceRef.startsWith(DRAFT_RECOUNT_PREFIX);
}

interface ShipmentsTabProps {
  onNavigateToInvoice?: (invoiceId: string) => void;
}

const CHANNEL_LABELS: Record<string, string> = {
  taproom: "Taproom",
  distribution: "Distribution",
  contract_brewing: "Contract",
  wholesale: "Wholesale",
};

// Channel badge classes from the shared category palette (bg + text).
const CHANNEL_BADGE: Record<string, string> = Object.fromEntries(
  Object.entries(CHANNEL_COLOR).map(([k, v]) => [k, `${v.bg} ${v.text}`])
);

const CHANNEL_OPTIONS = (["taproom", "distribution", "contract_brewing", "wholesale"] as const).map((c) => ({
  value: c, label: CHANNEL_LABELS[c], className: CHANNEL_BADGE[c],
}));

const STATUS_OPTIONS = [
  { value: "invoice_required", label: "Invoice Required" },
  { value: "draft", label: "Invoice Drafted" },
  { value: "unpaid", label: "Unpaid" },
  { value: "paid", label: "Paid" },
];

const SHIPMENT_CONTROLS: ControlsConfig<InvoiceGroup> = {
  // A card matches when ANY of its product lines is that beer; the whole card
  // then renders intact, consistent with how the categorical filters behave.
  search: [{ param: "q_recipe", accessor: (g) => g.products.map((p) => p.beer_name) }],
  filters: [
    { param: "channel", matches: (g, sel) => g.products.some((p) => sel.includes(p.channel)) },
    { param: "status", accessor: (g) => g.status },
    { param: "customer", accessor: (g) => g.recipient_id ?? "" },
  ],
};

const STATUS_BADGE: Record<string, string> = {
  paid: "bg-success-surface/40 text-success",
  unpaid: "bg-accent-muted/40 text-accent",
  draft: "bg-info-surface/40 text-info",
  invoice_required: "bg-surface-mid text-secondary",
};

const STATUS_LABELS: Record<string, string> = {
  paid: "Paid",
  unpaid: "Unpaid",
  draft: "Invoice Drafted",
  invoice_required: "Invoice Required",
};

const STATUS_RANK: Record<string, number> = { invoice_required: 3, draft: 2, unpaid: 1, paid: 0 };

const PKG_FORMAT_LABELS: Record<string, string> = {
  loose: "Loose", "4-pack": "4-Pack", "6-pack": "6-Pack", case: "Case",
};
const PKG_FORMAT_ORDER: Record<string, number> = {
  loose: 0, "4-pack": 1, "6-pack": 2, case: 3,
};

// Shared grid template so the column header and every product row stay aligned.
// checkbox | date | channel | category | recipe | variation | qty | bbl | tax | chevron
const ROW_GRID_COLS = "20px 84px 80px 92px minmax(110px,1fr) minmax(150px,1.5fr) 48px 72px 60px 20px";

function getPackagingCategory(row: ShipmentRow): { label: string; sortKey: [number, number, number] } {
  const type = row.packaging_item_type;
  const vol = row.packaging_item_volume_fl_oz ?? 0;
  const format = row.packaging_format;

  if (type === "keg") {
    // Normalize to the keg size, stripping any brand prefix so that
    // "Fortnight 1/2 Keg", "Local Time 1/2 Keg", and "1/2 Keg" all share
    // the same category ("1/2 Keg"). The size token sits right before "Keg".
    const name = row.packaging_item_name ?? "Keg";
    const sizeMatch = name.match(/(\S+)\s+Keg$/i);
    return {
      label: sizeMatch ? `${sizeMatch[1]} Keg` : name,
      sortKey: [0, -vol, 0],  // kegs first; bigger keg (higher vol) sorts earlier via negative
    };
  }
  if (type === "can") {
    const formatLabel = format ? (PKG_FORMAT_LABELS[format] ?? format) : "";
    return {
      label: `${vol}oz ${formatLabel}`.trim(),
      sortKey: [1, vol, PKG_FORMAT_ORDER[format ?? ""] ?? 99],
    };
  }
  return { label: row.variant_label, sortKey: [2, 0, 0] };
}

function unitLabel(type: string | null): string {
  if (type === "keg") return "kegs";
  if (type === "can") return "cans";
  return "units";
}

function fmtQty(n: number): string {
  return Math.abs(n - Math.round(n)) < 0.0001 ? String(Math.round(n)) : n.toFixed(4);
}

function groupByInvoice(rows: ShipmentRow[]): InvoiceGroup[] {
  const map = new Map<string, InvoiceGroup>();

  for (const row of rows) {
    // Taproom consumption groups by day; invoiced rows share a card; other
    // un-invoiced shipments group by shipment_id.
    const isTaproom = row.channel === "taproom";
    // Bucket taproom consumption by brewery-local business day, not the raw UTC
    // slice — an evening transaction (e.g. 9pm ET) has a UTC date of the *next*
    // day, which would otherwise land it in the wrong day-group.
    const day = localDateString(row.created_at);
    const key = isTaproom ? `taproom:${day}` : (row.invoice_id ?? row.shipment_id);
    const displayStatus = rowDisplayStatus(row);

    if (!map.has(key)) {
      map.set(key, {
        key,
        invoice_id: row.invoice_id,
        invoice_number: row.invoice_number,
        recipient_id: row.recipient_id,
        recipient_name: row.recipient_name,
        status: displayStatus,
        isTaproom,
        day: isTaproom ? day : null,
        products: [],
      });
    }

    const group = map.get(key)!;

    if (STATUS_RANK[displayStatus] > STATUS_RANK[group.status]) {
      group.status = displayStatus;
    }

    let product = group.products.find(
      (p) => p.recipe_id === row.recipe_id && p.variant_label === row.variant_label
    );
    if (!product) {
      const { label, sortKey } = getPackagingCategory(row);
      product = {
        recipe_id: row.recipe_id,
        // A batchless row still knows its recipe, so fall through to the recipe
        // name before giving up. "Unknown" now means genuinely unidentifiable,
        // not merely "no batch linked".
        beer_name: row.brew_batches?.beer_name ?? row.recipe_beer_name ?? "Unknown",
        variant_label: row.variant_label,
        packaging_category: label,
        unit_label: unitLabel(row.packaging_item_type),
        packaging_sort_key: sortKey,
        channel: row.channel,
        created_at: row.created_at,
        total_quantity: 0,
        total_volume_bbl: 0,
        total_excise_tax_usd: 0,
        isDraftRecount: false,
        reconcileState: null,
        allocations: [],
      };
      group.products.push(product);
    }

    if (isDraftRecountRef(row.source_ref)) product.isDraftRecount = true;
    product.reconcileState = worseReconcileState(product.reconcileState, rowReconcileState(row));

    product.total_quantity = Math.round((product.total_quantity + Number(row.quantity)) * 10000) / 10000;
    product.total_volume_bbl = Math.round((product.total_volume_bbl + Number(row.volume_bbl)) * 10000) / 10000;
    product.total_excise_tax_usd = Math.round((product.total_excise_tax_usd + Number(row.total_excise_tax_usd)) * 100) / 100;
    product.allocations.push({
      id: row.id,
      batch_number: row.brew_batches?.batch_number ?? "",
      quantity: Number(row.quantity),
      volume_bbl: Number(row.volume_bbl),
      status: displayStatus,
      created_at: row.created_at,
    });
  }

  // Sort products within each group by packaging category (kegs first, then cans; by size; by format)
  for (const group of map.values()) {
    group.products.sort((a, b) => {
      for (let i = 0; i < 3; i++) {
        const diff = a.packaging_sort_key[i] - b.packaging_sort_key[i];
        if (diff !== 0) return diff;
      }
      return a.variant_label.localeCompare(b.variant_label);
    });
  }

  return Array.from(map.values());
}

export default function ShipmentsTab({ onNavigateToInvoice }: ShipmentsTabProps) {
  const { data: allRows = [] } = useQuery({
    queryKey: queryKeys.production.exports(),
    queryFn: () => fetchJson<ShipmentRow[]>("/api/production/exports"),
  });
  const { data: partners = [] } = useContractPartnersQuery();
  const qc = useQueryClient();
  const [expandedProducts, setExpandedProducts] = useState<Set<string>>(new Set());

  function toggleExpand(key: string) {
    setExpandedProducts((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const [selected, setSelected] = useState<{ customerId: string; ids: Set<string> } | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [showMarkPaid, setShowMarkPaid] = useState(false);
  const [mpSource, setMpSource] = useState<"quickbooks" | "other">("quickbooks");
  const [mpRef, setMpRef] = useState("");
  const [mpPaidAt, setMpPaidAt] = useState(() => new Date().toISOString().slice(0, 10));
  const [mpAmount, setMpAmount] = useState("");
  const [mpLoading, setMpLoading] = useState(false);
  const [mpError, setMpError] = useState<string | null>(null);

  const partnerById = useMemo(() => new Map(partners.map((p) => [p.id, p])), [partners]);
  const partnerNameById = useMemo(() => new Map(partners.map((p) => [p.id, p.company_name])), [partners]);

  const invoiceGroups = useMemo(() => groupByInvoice(allRows), [allRows]);

  const { rows: hookFiltered, search, filters, setSearch, setFilter, reset, activeCount } =
    useTableControls(invoiceGroups, SHIPMENT_CONTROLS, { prefix: "ship_" });

  // Date range stays a local, non-URL-synced control (design non-goal: date-range
  // selectors are exempt from the shared filter primitives) — applied after the
  // hook's categorical filtering.
  const filtered = useMemo(() => hookFiltered.filter((g) => {
    if (!dateFrom && !dateTo) return true;
    return g.products.some((p) => p.allocations.some((a) => {
      const day = a.created_at.slice(0, 10);
      if (dateFrom && day < dateFrom) return false;
      if (dateTo && day > dateTo) return false;
      return true;
    }));
  }), [hookFiltered, dateFrom, dateTo]);

  const summaryStats = useMemo(() => {
    let totalBbl = 0;
    let totalExciseTax = 0;
    for (const group of filtered) {
      for (const product of group.products) {
        totalBbl += product.total_volume_bbl;
        totalExciseTax += product.total_excise_tax_usd;
      }
    }
    return {
      totalBbl: Math.round(totalBbl * 10000) / 10000,
      totalExciseTax: Math.round(totalExciseTax * 100) / 100,
    };
  }, [filtered]);

  const lockedCustomerId = selected?.customerId ?? null;

  const invoiceablePartners = useMemo(() => {
    const seen = new Set<string>();
    return allRows
      .filter((r) => r.recipient_id && !seen.has(r.recipient_id) && seen.add(r.recipient_id))
      .map((r) => ({
        id: r.recipient_id!,
        name: partnerNameById.get(r.recipient_id!) ?? r.recipient_name ?? "Unknown",
      }));
  }, [allRows, partnerNameById]);

  function toggleProduct(product: GroupProductRow, recipientId: string | null) {
    const ids = product.allocations.map((a) => a.id);
    const cid = recipientId ?? "";
    if (!selected || selected.customerId !== cid) {
      setSelected({ customerId: cid, ids: new Set(ids) });
      return;
    }
    const next = new Set(selected.ids);
    const allChecked = ids.every((id) => next.has(id));
    if (allChecked) {
      ids.forEach((id) => next.delete(id));
    } else {
      ids.forEach((id) => next.add(id));
    }
    setSelected(next.size > 0 ? { customerId: cid, ids: next } : null);
  }

  function isProductChecked(product: GroupProductRow): boolean {
    return !!selected && product.allocations.every((a) => selected.ids.has(a.id));
  }

  function canProductCheck(product: GroupProductRow, group: InvoiceGroup): boolean {
    if (product.channel === "taproom") return false;
    // Once an invoice exists (draft, sent, or paid) these lines are spoken for —
    // block re-selection so a second invoice can't be generated for them.
    if (group.invoice_id) return false;
    if (product.allocations.some((a) => a.status !== "invoice_required")) return false;
    if (lockedCustomerId && group.recipient_id !== lockedCustomerId) return false;
    return true;
  }

  function clearSelection() { setSelected(null); }

  function handleInvoiceCreated() {
    setShowModal(false);
    setSelected(null);
    qc.invalidateQueries({ queryKey: queryKeys.production.exports() });
    qc.invalidateQueries({ queryKey: queryKeys.production.exportInvoices() });
  }

  function openMarkPaid() {
    setMpSource("quickbooks"); setMpRef(""); setMpPaidAt(new Date().toISOString().slice(0, 10));
    setMpAmount(""); setMpError(null); setShowMarkPaid(true);
  }

  async function submitMarkPaid() {
    if (!selected) return;
    const cents = Math.round(parseFloat(mpAmount) * 100);
    setMpError(null); setMpLoading(true);
    try {
      const res = await fetch("/api/production/export/invoice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "mark_paid",
          transactionIds: [...selected.ids],
          source: mpSource,
          external_ref: mpRef.trim() || undefined,
          paid_at: mpPaidAt,
          total_cents: cents,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      setShowMarkPaid(false);
      setSelected(null);
      qc.invalidateQueries({ queryKey: queryKeys.production.exports() });
      qc.invalidateQueries({ queryKey: queryKeys.production.exportInvoices() });
    } catch (e: unknown) {
      setMpError(e instanceof Error ? e.message : "Failed to mark as paid");
    } finally { setMpLoading(false); }
  }

  const mpAmountCents = Math.round(parseFloat(mpAmount) * 100);
  const mpValid = !!mpPaidAt && !isNaN(mpAmountCents) && mpAmountCents >= 0 &&
    (mpSource === "other" || mpRef.trim().length > 0);

  const selectedCustomerName = selected ? (partnerNameById.get(selected.customerId) ?? "Unknown") : "";
  const hasSquareCustomer = selected ? !!partnerById.get(selected.customerId)?.square_customer_id : false;

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <FilterBar
        activeCount={activeCount}
        onClear={() => { reset(); setDateFrom(""); setDateTo(""); }}
      >
        <SearchInput
          value={search.q_recipe ?? ""}
          onChange={(v) => setSearch("q_recipe", v)}
          placeholder="Search recipe…"
        />
        <FilterChips
          label="Channel"
          options={CHANNEL_OPTIONS}
          value={filters.channel ?? []}
          onChange={(v) => setFilter("channel", v)}
        />
        <FilterSelect
          label="Status"
          options={STATUS_OPTIONS}
          value={filters.status ?? []}
          onChange={(v) => setFilter("status", v)}
        />
        <FilterSelect
          label="Customer"
          options={invoiceablePartners.map((p) => ({ value: p.id, label: p.name }))}
          value={filters.customer ?? []}
          onChange={(v) => setFilter("customer", v)}
        />
        {/* date range stays a local control (design non-goal: date-range selectors unchanged) */}
        <label className="inline-flex items-center gap-1.5 text-xs text-muted">
          From
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="inp-sm w-auto"
          />
        </label>
        <label className="inline-flex items-center gap-1.5 text-xs text-muted">
          To
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="inp-sm w-auto"
          />
        </label>
      </FilterBar>

      {/* Summary stats */}
      {filtered.length > 0 && (
        <div className="flex items-center gap-4 px-4 py-2 bg-surface/30 border border-line rounded-lg text-xs">
          <span className="text-muted">
            Showing <span className="tabular-nums">{formatNumber(filtered.length)}</span> shipment{filtered.length !== 1 ? "s" : ""}
          </span>
          <span className="text-disabled">·</span>
          <span className="text-body">
            <span className="tabular-nums font-medium">{formatNumber(summaryStats.totalBbl, 2)}</span>
            <span className="text-muted ml-1">bbl</span>
          </span>
          <span className="text-disabled">·</span>
          <span className="text-body">
            <span className="tabular-nums font-medium">{formatCurrency(summaryStats.totalExciseTax)}</span>
            <span className="text-muted ml-1">excise tax</span>
          </span>
        </div>
      )}

      {/* Invoice group list */}
      {filtered.length === 0 ? (
        <p className="text-sm text-faint">No shipments match the current filters.</p>
      ) : (
        <div className="space-y-3">
          {/* Column header — aligned to the product-row grid */}
          <div
            className="grid items-center gap-3 px-4 text-[10px] font-medium uppercase tracking-wide text-faint"
            style={{ gridTemplateColumns: ROW_GRID_COLS }}
          >
            <span />
            <span>Date</span>
            <span>Channel</span>
            <span>Category</span>
            <span>Recipe</span>
            <span>Variation</span>
            <span className="text-right">Qty</span>
            <span className="text-right">BBL</span>
            <span className="text-right">Tax</span>
            <span />
          </div>

          {filtered.map((group) => {
            const isLocked = !!lockedCustomerId && group.recipient_id !== lockedCustomerId;
            const partnerName = group.recipient_id
              ? (partnerNameById.get(group.recipient_id) ?? group.recipient_name ?? "Unknown")
              : "—";

            return (
              <div
                key={group.key}
                className={`border border-line rounded-lg overflow-hidden transition-opacity ${isLocked ? "opacity-40" : ""}`}
              >
                {/* Group header: invoice#/day + customer + status */}
                <div className="flex items-center gap-3 px-4 py-2.5 bg-surface/50 border-b border-line text-xs">
                  {group.isTaproom ? (
                    <>
                      <span className={`px-1.5 py-0.5 rounded whitespace-nowrap ${CHANNEL_BADGE.taproom ?? "bg-surface-mid text-secondary"}`}>
                        Taproom
                      </span>
                      <span className="text-strong font-medium">{group.day ? fmtDateLong(group.day) : "—"}</span>
                    </>
                  ) : (
                    <>
                      {group.invoice_id ? (
                        <button
                          onClick={() => onNavigateToInvoice?.(group.invoice_id!)}
                          className="font-mono font-medium text-accent hover:text-accent-soft underline"
                        >
                          {group.invoice_number ? `#${group.invoice_number}` : "View invoice"}
                        </button>
                      ) : (
                        <span className="text-faint italic">No invoice</span>
                      )}
                      <span className="text-strong font-medium">{partnerName}</span>
                    </>
                  )}
                  <div className="ml-auto">
                    <span className={`px-1.5 py-0.5 rounded ${STATUS_BADGE[group.status] ?? "bg-surface-mid text-secondary"}`}>
                      {STATUS_LABELS[group.status] ?? group.status}
                    </span>
                  </div>
                </div>

                {/* Product rows — each shows date, channel, beer, packaging, qty */}
                {group.products.map((product, pi) => {
                  const isLastProduct = pi === group.products.length - 1;
                  const checked = isProductChecked(product);
                  const canCheck = canProductCheck(product, group);
                  const productKey = `${group.key}:${product.recipe_id ?? ""}:${product.variant_label}`;
                  const isExpanded = expandedProducts.has(productKey);

                  return (
                    <div
                      key={`${product.recipe_id ?? ""}:${product.variant_label}`}
                      className={!isLastProduct ? "border-b border-line" : undefined}
                    >
                      {/* Grid columns: checkbox | date | channel | category | recipe | variation | qty | bbl | tax | chevron */}
                      <div
                        className="grid items-center gap-3 px-4 py-2.5"
                        style={{ gridTemplateColumns: ROW_GRID_COLS }}
                      >
                        <div className="flex items-center justify-center">
                          {canCheck ? (
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleProduct(product, group.recipient_id)}
                              className="accent-amber-500"
                              aria-label={`Select ${product.beer_name}`}
                            />
                          ) : null}
                        </div>

                        {/* Date */}
                        <span className="text-xs text-muted whitespace-nowrap">
                          {fmtDateLong(product.created_at)}
                        </span>

                        {/* Channel badge */}
                        <span className={`text-xs px-1.5 py-0.5 rounded whitespace-nowrap ${CHANNEL_BADGE[product.channel] ?? "bg-surface-mid text-secondary"}`}>
                          {CHANNEL_LABELS[product.channel] ?? product.channel}
                        </span>

                        {/* Packaging category */}
                        <span
                          className="text-xs px-1.5 py-0.5 rounded bg-surface-mid text-body whitespace-nowrap overflow-hidden text-ellipsis"
                          title={product.packaging_category}
                        >
                          {product.packaging_category}
                        </span>

                        {/* Recipe */}
                        <span className="text-sm text-strong truncate" title={product.beer_name}>
                          {product.beer_name}
                        </span>

                        {/* Packaging variation (actual variation shipped) */}
                        <span className="flex items-center gap-1.5 min-w-0">
                          <span className="text-xs text-secondary truncate" title={product.variant_label}>
                            {product.variant_label}
                          </span>
                          {product.isDraftRecount && (
                            <span
                              className="text-[10px] px-1.5 py-0.5 rounded bg-info-surface/50 text-info whitespace-nowrap shrink-0"
                              title="Keg drained by a draft line restock (recount swap), not a partner shipment"
                            >
                              Draft recount
                            </span>
                          )}
                          {product.reconcileState === "unreconciled" && (
                            <span
                              className="text-[10px] px-1.5 py-0.5 rounded bg-danger-surface/50 text-danger whitespace-nowrap shrink-0"
                              title="Barrel excise was booked with no cold-storage keg to deduct. Resolve or dismiss it under Export Bay."
                            >
                              Unreconciled
                            </span>
                          )}
                          {product.reconcileState === "no_stock" && (
                            <span
                              className="text-[10px] px-1.5 py-0.5 rounded bg-surface-mid text-muted whitespace-nowrap shrink-0"
                              title="Reviewed under Export Bay and dismissed — there was no cold-storage keg to draw down, so this recount stays batchless by design."
                            >
                              No cold-storage stock
                            </span>
                          )}
                        </span>

                        {/* Qty */}
                        <span className="text-sm text-strong tabular-nums text-right">
                          {fmtQty(product.total_quantity)}
                        </span>

                        {/* BBL */}
                        <span className="text-xs text-muted tabular-nums text-right">
                          {product.total_volume_bbl.toFixed(2)}<span className="text-disabled ml-0.5">bbl</span>
                        </span>

                        {/* Excise tax */}
                        <span className="text-xs text-muted tabular-nums text-right">
                          ${product.total_excise_tax_usd.toFixed(2)}
                        </span>

                        {/* Expand chevron */}
                        <button
                          onClick={() => toggleExpand(productKey)}
                          className="text-faint hover:text-secondary transition-colors flex justify-center"
                          aria-label={isExpanded ? "Collapse allocation detail" : "Expand allocation detail"}
                        >
                          <svg
                            className={`w-3.5 h-3.5 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                          </svg>
                        </button>
                      </div>

                      {/* Allocation sub-rows */}
                      {isExpanded && (
                        <div className="pl-[4.5rem] pr-4 pb-2.5 space-y-1">
                          {product.allocations.map((alloc) => (
                            <div key={alloc.id} className="flex items-center gap-2 text-xs text-muted">
                              <span className="text-disabled">└</span>
                              <span className="font-mono text-secondary">#{alloc.batch_number}</span>
                              <span className="text-disabled">·</span>
                              <span className="tabular-nums">{fmtQty(alloc.quantity)} {product.unit_label}</span>
                              <span className="text-disabled">·</span>
                              <span className="tabular-nums">{alloc.volume_bbl.toFixed(4)} bbl</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}

      {/* Sticky action bar */}
      {selected && selected.ids.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 px-4 py-2.5 bg-surface border border-line-strong rounded-xl shadow-2xl text-sm">
          <span className="text-secondary">
            {selected.ids.size} line{selected.ids.size !== 1 ? "s" : ""} selected
            {selectedCustomerName && <> — <span className="text-strong">{selectedCustomerName}</span></>}
          </span>
          {!hasSquareCustomer && (
            <span className="text-xs text-muted">No Square customer linked</span>
          )}
          <button
            onClick={() => setShowModal(true)}
            className="btn-primary"
          >
            Generate Invoice
          </button>
          <button
            onClick={openMarkPaid}
            className="btn-primary"
          >
            Mark Paid
          </button>
          <button onClick={clearSelection} className="btn-secondary">
            Clear
          </button>
        </div>
      )}

      {showModal && selected && (
        <InvoicePreviewModal
          transactionIds={[...selected.ids]}
          onClose={() => setShowModal(false)}
          onCreated={handleInvoiceCreated}
        />
      )}

      {showMarkPaid && selected && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setShowMarkPaid(false)}
        >
          <div
            className="bg-surface border border-line-strong rounded-xl shadow-xl w-full max-w-sm p-5 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-sm font-semibold text-primary">Mark as Paid (External)</h2>
            <p className="text-xs text-muted">
              Record payment for {selected.ids.size} transaction{selected.ids.size !== 1 ? "s" : ""} collected outside of Square.
            </p>
            <div className="space-y-3">
              <div className="space-y-1">
                <label htmlFor="mp-source" className="text-xs text-secondary">Source</label>
                <select
                  id="mp-source"
                  value={mpSource}
                  onChange={(e) => setMpSource(e.target.value as "quickbooks" | "other")}
                  className="w-full bg-surface-mid border border-line-strong rounded px-2 py-1.5 text-sm text-strong"
                >
                  <option value="quickbooks">QuickBooks</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <div className="space-y-1">
                <label htmlFor="mp-ref" className="text-xs text-secondary">
                  {mpSource === "quickbooks" ? <>QB Invoice # <span className="text-danger">*</span></> : "Reference # (optional)"}
                </label>
                <input
                  id="mp-ref"
                  type="text"
                  value={mpRef}
                  onChange={(e) => setMpRef(e.target.value)}
                  placeholder={mpSource === "quickbooks" ? "e.g. INV-1042" : "e.g. check #1234"}
                  className="w-full bg-surface-mid border border-line-strong rounded px-2 py-1.5 text-sm text-strong placeholder:text-faint"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label htmlFor="mp-paid-at" className="text-xs text-secondary">
                    Date paid <span className="text-danger">*</span>
                  </label>
                  <input
                    id="mp-paid-at"
                    type="date"
                    value={mpPaidAt}
                    onChange={(e) => setMpPaidAt(e.target.value)}
                    className="w-full bg-surface-mid border border-line-strong rounded px-2 py-1.5 text-sm text-strong"
                  />
                </div>
                <div className="space-y-1">
                  <label htmlFor="mp-amount" className="text-xs text-secondary">
                    Total ($) <span className="text-danger">*</span>
                  </label>
                  <input
                    id="mp-amount"
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={mpAmount}
                    onChange={(e) => setMpAmount(e.target.value)}
                    placeholder="0.00"
                    className="w-full bg-surface-mid border border-line-strong rounded px-2 py-1.5 text-sm text-strong placeholder:text-faint"
                  />
                </div>
              </div>
            </div>
            {mpError && <p className="text-xs text-danger">{mpError}</p>}
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setShowMarkPaid(false)} className="btn-secondary">
                Cancel
              </button>
              <button
                onClick={submitMarkPaid}
                disabled={mpLoading || !mpValid}
                className="btn-primary"
              >
                {mpLoading ? "Saving…" : "Mark Paid"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
