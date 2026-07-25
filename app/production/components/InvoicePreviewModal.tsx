"use client";

import { useMemo, useState } from "react";
import { Modal } from "./shared";
import Banner from "@/app/components/ui/Banner";
import PackagingMaterialsBreakdownModal from "./PackagingMaterialsBreakdownModal";
import { SquareCatalogSelect, SquareDiscountSelect } from "@/app/components/SquareCatalogSelect";
import { useInvoicePreview, useExportSquareCatalogQuery } from "../hooks/queries";
import type { SquareCatalogOptions } from "../types";
import { fmtUsd } from "@/lib/utils/formatting";
import { crossesExciseTreatmentBoundary } from "@/lib/tax/parties/ncDorBeerExcise/rates";

// Channels an export invoice can be billed under (taproom is not invoiceable
// here). Used by the "Bill as" override selector.
const BILL_AS_OPTIONS: { value: string; label: string }[] = [
  { value: "distribution", label: "Distribution" },
  { value: "contract_brewing", label: "Contract Brewing" },
  { value: "wholesale", label: "Wholesale" },
];

interface DraftLineItem {
  id: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
  squareCatalogVariationId: string | null;
  discountCatalogId?: string | null;
}

type CatalogDiscount = SquareCatalogOptions["discounts"][number];

// Estimate what a Square catalog discount takes off a line's subtotal. Square
// computes the authoritative amount on its side; this is only for showing the
// user a running total in the modal.
function estimateDiscountCents(subtotalCents: number, d: CatalogDiscount | undefined): number {
  if (!d || subtotalCents <= 0) return 0;
  if (d.percentage) {
    const pct = parseFloat(d.percentage);
    if (!Number.isNaN(pct)) return Math.round(subtotalCents * (pct / 100));
  }
  if (d.amountCents != null) return Math.min(d.amountCents, subtotalCents);
  return 0;
}

function discountLabel(d: CatalogDiscount): string {
  if (d.percentage) return `${d.name} (${d.percentage}%)`;
  if (d.amountCents != null) return `${d.name} (${fmtUsd(d.amountCents / 100)})`;
  return d.name;
}

export default function InvoicePreviewModal({
  transactionIds,
  onClose,
  onCreated,
}: {
  transactionIds: string[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [billAsChannel, setBillAsChannel] = useState<string | null>(null);
  const { data, isLoading, error: previewError } = useInvoicePreview(transactionIds, billAsChannel);
  const { data: catalog } = useExportSquareCatalogQuery();
  const [lineItems, setLineItems] = useState<DraftLineItem[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // Line id whose Packaging Materials cost derivation is open in a sub-modal.
  const [breakdownLineId, setBreakdownLineId] = useState<string | null>(null);

  // ── Manual invoice mode ────────────────────────────────────────────────────
  const [invoiceMode, setInvoiceMode] = useState<"square" | "manual">("square");
  const [manualSource, setManualSource] = useState<"quickbooks" | "other">("quickbooks");
  const [manualRef, setManualRef] = useState("");
  const [manualDate, setManualDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [overrideReason, setOverrideReason] = useState("");

  const effectiveLineItems = lineItems ?? data?.lineItems ?? [];
  const materialBreakdowns = data?.materialBreakdowns ?? {};
  const openBreakdown = breakdownLineId ? materialBreakdowns[breakdownLineId] : undefined;
  const channel = data?.channel ?? null;
  const discountsApply = channel === "distribution" || channel === "wholesale";

  // ── Billing-channel override ────────────────────────────────────────────────
  const shippedChannel = data?.shippedChannel ?? null;
  const isOverride = !!shippedChannel && !!channel && channel !== shippedChannel;
  const crossesExcise = isOverride && shippedChannel != null && channel != null
    && crossesExciseTreatmentBoundary(shippedChannel, channel);

  // ── Catalog lookups ─────────────────────────────────────────────────────────
  const items = useMemo(() => catalog?.items ?? [], [catalog]);
  const discounts = useMemo(() => catalog?.discounts ?? [], [catalog]);

  const variationIndex = useMemo(() => {
    const m = new Map<string, { itemId: string; itemName: string; variationName: string; priceCents: number | null }>();
    for (const it of items) {
      for (const v of it.variations) {
        m.set(v.variationId, {
          itemId: it.itemId,
          itemName: it.itemName,
          variationName: v.variationName,
          priceCents: v.priceCents ?? null,
        });
      }
    }
    return m;
  }, [items]);

  const discountById = useMemo(
    () => new Map(discounts.map((d) => [d.id, d])),
    [discounts]
  );

  const defaultDiscount = data?.defaultDiscountCatalogId
    ? discountById.get(data.defaultDiscountCatalogId)
    : undefined;

  // ── Line mutations ────────────────────────────────────────────────────────
  function updateLine(id: string, patch: Partial<DraftLineItem>) {
    setLineItems(effectiveLineItems.map((li) => (li.id === id ? { ...li, ...patch } : li)));
  }

  function removeLine(id: string) {
    setLineItems(effectiveLineItems.filter((li) => li.id !== id));
  }

  function addLine() {
    setLineItems([
      ...effectiveLineItems,
      { id: crypto.randomUUID(), description: "", quantity: 1, unitPriceCents: 0, squareCatalogVariationId: null, discountCatalogId: null },
    ]);
  }

  // Picking a Square catalog item fills in the mapped variation, its name, and
  // its catalog price — the way Square's own invoice editor behaves.
  function pickCatalogItem(id: string, variationId: string | null) {
    if (!variationId) {
      updateLine(id, { squareCatalogVariationId: null });
      return;
    }
    const v = variationIndex.get(variationId);
    updateLine(id, {
      squareCatalogVariationId: variationId,
      description: v ? `${v.itemName}${v.variationName ? ` · ${v.variationName}` : ""}` : effectiveLineItems.find((li) => li.id === id)?.description ?? "",
      ...(v?.priceCents != null ? { unitPriceCents: v.priceCents } : {}),
    });
  }

  function applyDefaultDiscountToAll() {
    const discId = data?.defaultDiscountCatalogId;
    if (!discId) return;
    setLineItems(effectiveLineItems.map((li) => ({ ...li, discountCatalogId: discId })));
  }

  function clearAllDiscounts() {
    setLineItems(effectiveLineItems.map((li) => ({ ...li, discountCatalogId: null })));
  }

  // ── Totals ───────────────────────────────────────────────────────────────
  const subtotalCents = effectiveLineItems.reduce((s, li) => s + li.quantity * li.unitPriceCents, 0);
  const discountCents = invoiceMode === "square"
    ? effectiveLineItems.reduce(
        (s, li) => s + estimateDiscountCents(li.quantity * li.unitPriceCents, li.discountCatalogId ? discountById.get(li.discountCatalogId) : undefined),
        0
      )
    : 0;
  const netTotalCents = subtotalCents - discountCents;

  const manualValid = subtotalCents > 0 && effectiveLineItems.length > 0 &&
    (manualSource === "other" || manualRef.trim().length > 0);

  async function handleCreate() {
    setCreating(true);
    setCreateError(null);
    try {
      if (invoiceMode === "square") {
        const res = await fetch("/api/production/export/invoice", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "generate",
            transactionIds,
            lineItems: effectiveLineItems,
            bill_as_channel: billAsChannel ?? undefined,
            override_reason: isOverride ? overrideReason.trim() : undefined,
          }),
        });
        if (!res.ok) throw new Error((await res.json()).error ?? "Failed to create invoice");
      } else {
        const res = await fetch("/api/production/export/invoice", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "record",
            transactionIds,
            source: manualSource,
            external_ref: manualRef.trim() || undefined,
            invoice_date: manualDate,
            total_cents: subtotalCents,
            lineItems: effectiveLineItems,
            bill_as_channel: billAsChannel ?? undefined,
            override_reason: isOverride ? overrideReason.trim() : undefined,
          }),
        });
        if (!res.ok) throw new Error((await res.json()).error ?? "Failed to record invoice");
      }
      onCreated();
    } catch (e: unknown) {
      setCreateError(e instanceof Error ? e.message : "Error");
    } finally {
      setCreating(false);
    }
  }

  const title = invoiceMode === "square"
    ? `Generate Invoice — ${data?.customerName ?? "…"}`
    : `Manual Invoice — ${data?.customerName ?? "…"}`;

  // Shared so it renders both in the normal body and in the preview-error state —
  // a mixed-channel selection errors until an override is chosen, so the selector
  // must stay reachable to recover from that error.
  const billAsSelector = (
    <div className="space-y-1">
      <label className="text-xs text-secondary">Bill as</label>
      <select
        className="inp-sm w-56"
        value={billAsChannel ?? shippedChannel ?? ""}
        onChange={(e) => {
          // Rebuild for the new channel — discard edited lines so they can't be
          // billed under the newly-selected channel (a line-item/channel mismatch).
          setBillAsChannel(e.target.value === shippedChannel ? null : e.target.value);
          setLineItems(null);
        }}
      >
        {BILL_AS_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );

  return (
    <>
    <Modal title={title} onClose={onClose} extraWide>
      {isLoading ? (
        <p className="text-sm text-muted">Loading line items…</p>
      ) : previewError ? (
        <div className="space-y-4">
          {billAsSelector}
          <Banner tone="danger">
            {previewError instanceof Error ? previewError.message : "Failed to load preview"}
          </Banner>
          <div className="flex justify-end pt-1">
            <button onClick={onClose} className="btn-secondary">Cancel</button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {/* ── Mode toggle ─────────────────────────────────────────────────── */}
          <div className="flex gap-1 p-0.5 bg-surface-mid rounded-lg w-fit">
            <button
              onClick={() => setInvoiceMode("square")}
              className={`px-3 py-1 text-xs rounded-md transition-colors ${
                invoiceMode === "square" ? "bg-surface-high text-primary" : "text-secondary hover:text-strong"
              }`}
            >
              Via Square
            </button>
            <button
              onClick={() => setInvoiceMode("manual")}
              className={`px-3 py-1 text-xs rounded-md transition-colors ${
                invoiceMode === "manual" ? "bg-surface-high text-primary" : "text-secondary hover:text-strong"
              }`}
            >
              Manual
            </button>
          </div>

          {/* ── Bill-as channel override ────────────────────────────────────── */}
          {billAsSelector}

          {isOverride && (
            <>
              <Banner tone="info">
                Shipped as <span className="font-medium">{shippedChannel}</span>; billing as{" "}
                <span className="font-medium">{channel}</span>. The shipment record and excise reporting are unchanged.
              </Banner>
              {crossesExcise && (
                <Banner tone="danger">
                  This shipment is reported to NC DOR as <span className="font-medium">{shippedChannel}</span>.
                  Billing it as <span className="font-medium">{channel}</span> does not change TPB&rsquo;s excise
                  liability — do not add an excise charge unless you also intend to reclassify the shipment for tax reporting.
                </Banner>
              )}
              <div className="space-y-1">
                <label className="text-xs text-secondary">Reason <span className="text-danger">*</span></label>
                <input
                  className="inp-sm w-full"
                  value={overrideReason}
                  placeholder="e.g. Fortnight pumpkin ale — billed contract per agreement"
                  onChange={(e) => setOverrideReason(e.target.value)}
                />
              </div>
            </>
          )}

          {/* ── Preview advisories (missing costs, unresolved materials) ──────── */}
          {(data?.warnings?.length ?? 0) > 0 && (
            <Banner tone="accent">
              <ul className="list-disc pl-4 space-y-0.5">
                {data!.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </Banner>
          )}

          {/* ── Manual-only fields ──────────────────────────────────────────── */}
          {invoiceMode === "manual" && (
            <div className="rounded-lg bg-surface border border-line p-3 grid grid-cols-3 gap-3">
              <div className="space-y-1">
                <label className="text-xs text-secondary">Source</label>
                <select
                  value={manualSource}
                  onChange={(e) => setManualSource(e.target.value as "quickbooks" | "other")}
                  className="w-full bg-surface-mid border border-line-strong rounded px-2 py-1.5 text-sm text-strong"
                >
                  <option value="quickbooks">QuickBooks</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-secondary">
                  {manualSource === "quickbooks" ? <>QB Invoice # <span className="text-danger">*</span></> : "Reference # (optional)"}
                </label>
                <input
                  type="text"
                  value={manualRef}
                  onChange={(e) => setManualRef(e.target.value)}
                  placeholder={manualSource === "quickbooks" ? "e.g. INV-1042" : "e.g. PO-5678"}
                  className="w-full bg-surface-mid border border-line-strong rounded px-2 py-1.5 text-sm text-strong placeholder:text-faint"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-secondary">Invoice date</label>
                <input
                  type="date"
                  value={manualDate}
                  onChange={(e) => setManualDate(e.target.value)}
                  className="w-full bg-surface-mid border border-line-strong rounded px-2 py-1.5 text-sm text-strong"
                />
              </div>
            </div>
          )}

          {/* ── Bulk-discount banner (distribution / wholesale, Square mode) ──── */}
          {invoiceMode === "square" && discountsApply && (
            defaultDiscount ? (
              <Banner tone="info" className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <span className="flex-1 min-w-[12rem]">
                  <span className="font-medium">{discountLabel(defaultDiscount)}</span> is the mapped{" "}
                  {channel === "distribution" ? "bulk" : "wholesale"} discount for this channel. Adjust or
                  remove it per line below, or apply other discounts at your discretion.
                </span>
                <span className="flex items-center gap-2 shrink-0">
                  <button onClick={applyDefaultDiscountToAll} className="btn-secondary">
                    Apply to all
                  </button>
                  <button onClick={clearAllDiscounts} className="text-xs text-secondary hover:text-strong">
                    Clear all
                  </button>
                </span>
              </Banner>
            ) : (
              <Banner tone="accent">
                No {channel === "distribution" ? "bulk" : "wholesale"} discount is mapped for this channel — set
                one under Export Settings → Service Mappings &amp; Discounts, or pick a discount manually per line.
              </Banner>
            )
          )}

          {/* ── Line items ──────────────────────────────────────────────────── */}
          <div className="space-y-2">
            {effectiveLineItems.map((li) => {
              const mapped = li.squareCatalogVariationId ? variationIndex.get(li.squareCatalogVariationId) : undefined;
              const lineSub = li.quantity * li.unitPriceCents;
              const lineDiscount = invoiceMode === "square" && li.discountCatalogId
                ? estimateDiscountCents(lineSub, discountById.get(li.discountCatalogId))
                : 0;
              const breakdown = materialBreakdowns[li.id];

              return (
                <div key={li.id} className="rounded-lg border border-line p-3 space-y-2.5">
                  {/* Square catalog item picker + remove */}
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1">
                      <label className="block text-[11px] uppercase tracking-wide text-muted">Square line item</label>
                      <SquareCatalogSelect
                        items={items}
                        itemId={mapped?.itemId ?? null}
                        variationId={li.squareCatalogVariationId}
                        onChange={(_itemId, variationId) => pickCatalogItem(li.id, variationId)}
                      />
                      {li.squareCatalogVariationId ? (
                        <p className="text-[11px] text-success">
                          ✓ Mapped{mapped ? `: ${mapped.itemName}${mapped.variationName ? ` · ${mapped.variationName}` : ""}` : " to Square catalog"}
                        </p>
                      ) : (
                        <p className="text-[11px] text-muted">Custom line — not linked to a Square catalog item</p>
                      )}
                    </div>
                    <button
                      onClick={() => removeLine(li.id)}
                      className="text-sm text-faint hover:text-danger shrink-0"
                      aria-label="Remove line item"
                    >
                      ×
                    </button>
                  </div>

                  {/* Description */}
                  <div className="space-y-1">
                    <label className="block text-[11px] uppercase tracking-wide text-muted">Description</label>
                    <input
                      className="inp-sm w-full"
                      value={li.description}
                      placeholder="Line description shown on the invoice"
                      onChange={(e) => updateLine(li.id, { description: e.target.value })}
                    />
                  </div>

                  {/* Qty / Unit price / Discount / Total */}
                  <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
                    <div className="space-y-1">
                      <label className="block text-[11px] uppercase tracking-wide text-muted">Qty</label>
                      <input
                        type="number" min={0} step="1"
                        className="inp-sm w-16 text-right"
                        value={li.quantity}
                        onChange={(e) => updateLine(li.id, { quantity: Number(e.target.value) })}
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="block text-[11px] uppercase tracking-wide text-muted">Unit price</label>
                      <input
                        type="number" min={0} step="0.01"
                        className="inp-sm w-24 text-right"
                        value={(li.unitPriceCents / 100).toFixed(2)}
                        onChange={(e) => updateLine(li.id, { unitPriceCents: Math.round(Number(e.target.value) * 100) })}
                      />
                    </div>
                    {invoiceMode === "square" && (
                      <div className="space-y-1">
                        <label className="block text-[11px] uppercase tracking-wide text-muted">Discount</label>
                        <SquareDiscountSelect
                          discounts={discounts}
                          value={li.discountCatalogId ?? null}
                          onChange={(discId) => updateLine(li.id, { discountCatalogId: discId })}
                        />
                      </div>
                    )}
                    <div className="ml-auto text-right space-y-0.5">
                      <label className="block text-[11px] uppercase tracking-wide text-muted">Line total</label>
                      {lineDiscount > 0 ? (
                        <span className="text-sm text-body tabular-nums">
                          <span className="text-faint line-through mr-1.5">{fmtUsd(lineSub / 100)}</span>
                          {fmtUsd((lineSub - lineDiscount) / 100)}
                        </span>
                      ) : (
                        <span className="text-sm text-body tabular-nums">{fmtUsd(lineSub / 100)}</span>
                      )}
                      {breakdown && (
                        <button
                          onClick={() => setBreakdownLineId(li.id)}
                          className="block ml-auto text-2xs text-accent hover:text-accent-soft underline"
                        >
                          How is this calculated?
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <button onClick={addLine} className="btn-secondary">
            + Add line item
          </button>

          {/* ── Totals ──────────────────────────────────────────────────────── */}
          <div className="pt-2 border-t border-line space-y-1">
            {discountCents > 0 && (
              <>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-secondary">Subtotal</span>
                  <span className="text-body tabular-nums">{fmtUsd(subtotalCents / 100)}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-secondary">Discounts (est.)</span>
                  <span className="text-success tabular-nums">−{fmtUsd(discountCents / 100)}</span>
                </div>
              </>
            )}
            <div className="flex items-center justify-between">
              <span className="text-sm text-secondary">Total{discountCents > 0 ? " (est.)" : ""}</span>
              <span className="text-sm font-medium text-primary tabular-nums">{fmtUsd(netTotalCents / 100)}</span>
            </div>
            {discountCents > 0 && (
              <p className="text-[11px] text-faint">Square calculates the exact discounted total when the invoice is created.</p>
            )}
          </div>

          {invoiceMode === "manual" && (
            <p className="text-xs text-muted">
              Manual invoices are recorded as <span className="text-body">Unpaid</span> — use &ldquo;Mark Paid&rdquo; once payment is received.
              Square catalog discounts don&rsquo;t apply to manually-recorded invoices.
            </p>
          )}

          {createError && <p className="text-xs text-danger">{createError}</p>}

          <div className="flex justify-end gap-2 pt-1">
            <button onClick={onClose} className="btn-secondary" disabled={creating}>Cancel</button>
            <button
              onClick={handleCreate}
              disabled={creating || effectiveLineItems.length === 0 || (invoiceMode === "manual" && !manualValid) || (isOverride && !overrideReason.trim())}
              className="btn-primary"
            >
              {creating
                ? (invoiceMode === "square" ? "Generating…" : "Recording…")
                : (invoiceMode === "square" ? "Generate Invoice" : "Create Manual Invoice")}
            </button>
          </div>
        </div>
      )}
    </Modal>
    {openBreakdown && (
      <PackagingMaterialsBreakdownModal
        breakdown={openBreakdown}
        onClose={() => setBreakdownLineId(null)}
      />
    )}
    </>
  );
}
