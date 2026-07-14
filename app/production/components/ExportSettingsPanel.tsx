"use client";

import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import {
  useContractPartnersQuery,
  usePackagingQuery,
  useExportServiceMappingsQuery,
  useExportInvoiceDueDaysQuery,
  useExportSquareCatalogQuery,
} from "../hooks/queries";
import type { ExportServiceMapping, ServiceType, SquareCatalogOptions } from "../types";
import { SquareCatalogSelect, SquareDiscountSelect } from "@/app/components/SquareCatalogSelect";
import ExciseRatesSection from "@/app/finance/settings/tax-filing/ExciseRatesSection";


const KEG_VOL_LABELS: Record<number, string> = { 1984: "1/2 BBL", 992: "1/4 BBL", 661: "1/6 BBL" };
const CAN_FORMAT_LABELS: Record<"loose" | "case", string> = { loose: "Loose Can", case: "Case" };

interface VolumeClass {
  piType: "keg" | "can";
  volumeFlOz: number;
  format: "loose" | "case" | null;
  label: string;
}

function deriveVolumeClasses(packagingItems: { id: string; type: string; volume_fl_oz: number | null }[]): VolumeClass[] {
  const seen = new Map<string, VolumeClass>();
  for (const pi of packagingItems) {
    if ((pi.type !== "keg" && pi.type !== "can") || pi.volume_fl_oz == null) continue;
    const piType = pi.type as "keg" | "can";
    const vol = pi.volume_fl_oz;
    if (piType === "keg") {
      const k = `keg|${vol}|null`;
      if (!seen.has(k)) {
        const size = KEG_VOL_LABELS[vol] ?? `${vol} fl oz`;
        seen.set(k, { piType, volumeFlOz: vol, format: null, label: `${size} Keg` });
      }
    } else {
      for (const fmt of ["loose", "case"] as const) {
        const k = `can|${vol}|${fmt}`;
        if (!seen.has(k)) {
          seen.set(k, { piType, volumeFlOz: vol, format: fmt, label: `${vol}oz Can · ${CAN_FORMAT_LABELS[fmt]}` });
        }
      }
    }
  }
  return [...seen.values()].sort((a, b) => {
    if (a.piType !== b.piType) return a.piType === "keg" ? -1 : 1;
    if (a.piType === "keg") return b.volumeFlOz - a.volumeFlOz;
    if (a.volumeFlOz !== b.volumeFlOz) return a.volumeFlOz - b.volumeFlOz;
    return (a.format === "loose" ? 0 : 1) - (b.format === "loose" ? 0 : 1);
  });
}


export function PartnerOverridePicker({ partners, excludeIds, onAdd }: {
  partners: { id: string; company_name: string }[];
  excludeIds: Set<string>;
  onAdd: (partnerId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [partnerId, setPartnerId] = useState("");
  const available = partners.filter((p) => !excludeIds.has(p.id));

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="text-xs text-accent-emphasis hover:text-accent transition-colors">
        + Add partner override
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <select value={partnerId} onChange={(e) => setPartnerId(e.target.value)}
        className="bg-surface-mid border border-line-strong rounded px-2 py-1 text-xs text-strong">
        <option value="">— select partner —</option>
        {available.map((p) => <option key={p.id} value={p.id}>{p.company_name}</option>)}
      </select>
      <button
        onClick={() => { if (partnerId) { onAdd(partnerId); setOpen(false); setPartnerId(""); } }}
        disabled={!partnerId}
        className="btn-primary"
      >
        Add
      </button>
      <button onClick={() => { setOpen(false); setPartnerId(""); }} className="text-xs text-muted hover:text-body">
        Cancel
      </button>
    </div>
  );
}

type SaveStatus = { state: "idle" | "saving" | "saved" | "error"; message?: string };

function SaveIndicator({ status }: { status: SaveStatus }) {
  if (status.state === "idle") return null;
  const text =
    status.state === "saving" ? "Saving…"
    : status.state === "saved" ? "Saved"
    : `⚠ ${status.message ?? "Save failed"}`;
  const color =
    status.state === "error" ? "text-danger"
    : status.state === "saved" ? "text-success"
    : "text-muted";
  return <span aria-live="polite" className={`text-xs shrink-0 ${color}`}>{text}</span>;
}

/** Wraps a save fetch with saving/saved/error status. Surfaces failures (the old
 *  auto-save selects swallowed them) and auto-clears the "saved" state. */
function useSaveStatus() {
  const [status, setStatus] = useState<SaveStatus>({ state: "idle" });
  useEffect(() => {
    if (status.state !== "saved") return;
    const t = setTimeout(() => setStatus({ state: "idle" }), 2000);
    return () => clearTimeout(t);
  }, [status]);
  async function run(request: () => Promise<Response>): Promise<boolean> {
    setStatus({ state: "saving" });
    try {
      const res = await request();
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setStatus({ state: "error", message: (body as { error?: string }).error ?? `Save failed (${res.status})` });
        return false;
      }
      setStatus({ state: "saved" });
      return true;
    } catch (err) {
      setStatus({ state: "error", message: err instanceof Error ? err.message : "Save failed" });
      return false;
    }
  }
  return { status, run };
}

interface ServiceRow {
  serviceType: ServiceType;
  label: string;
  kind: "catalog" | "discount";
}

const SERVICE_ROWS: ServiceRow[] = [
  { serviceType: "packaging_material", label: "Packaging Materials", kind: "catalog" },
  { serviceType: "keg_cleaning",       label: "Keg Cleaning",        kind: "catalog" },
  { serviceType: "forklift",           label: "Forklift",            kind: "catalog" },
  { serviceType: "distribution_discount",  label: "Distribution Discount",  kind: "discount" },
  { serviceType: "wholesale_discount",     label: "Wholesale Discount",     kind: "discount" },
];

function getMappingLabel(
  row: ServiceRow,
  mapping: ExportServiceMapping | null,
  items: SquareCatalogOptions["items"],
  discounts: SquareCatalogOptions["discounts"]
): string | null {
  if (!mapping) return null;
  if (row.kind === "catalog" && mapping.square_catalog_item_id) {
    const item = items.find((i) => i.itemId === mapping.square_catalog_item_id);
    const variation = item?.variations.find((v) => v.variationId === mapping.square_catalog_variation_id);
    if (item && variation) return `${item.itemName} · ${variation.variationName}`;
    return mapping.display_name || null;
  }
  if (row.kind === "discount" && mapping.square_catalog_discount_id) {
    return discounts.find((d) => d.id === mapping.square_catalog_discount_id)?.name ?? null;
  }
  return null;
}

function ServiceMappingDrawer({
  rowLabel, drawerKind, partnerName, mapping, items, discounts, onClose, onSave,
}: {
  rowLabel: string;
  drawerKind: "catalog" | "discount";
  partnerName: string;
  mapping: ExportServiceMapping | null;
  items: SquareCatalogOptions["items"];
  discounts: SquareCatalogOptions["discounts"];
  onClose: () => void;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
}) {
  const [pendingItemId, setPendingItemId] = useState<string | null>(null);
  const [pendingVariationId, setPendingVariationId] = useState<string | null>(null);
  const [pendingDiscountId, setPendingDiscountId] = useState<string | null>(null);
  const [pickerKey, setPickerKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasPending = drawerKind === "catalog"
    ? (pendingItemId !== null && pendingVariationId !== null)
    : pendingDiscountId !== null;

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const patch = drawerKind === "catalog"
        ? { square_catalog_item_id: pendingItemId, square_catalog_variation_id: pendingVariationId }
        : { square_catalog_discount_id: pendingDiscountId };
      await onSave(patch);
      setPendingItemId(null);
      setPendingVariationId(null);
      setPendingDiscountId(null);
      setPickerKey((k) => k + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  let currentLabel: string | null = null;
  if (drawerKind === "catalog" && mapping?.square_catalog_item_id) {
    const item = items.find((i) => i.itemId === mapping.square_catalog_item_id);
    const variation = item?.variations.find((v) => v.variationId === mapping.square_catalog_variation_id);
    currentLabel = item && variation ? `${item.itemName} · ${variation.variationName}` : mapping.display_name || null;
  } else if (drawerKind === "discount" && mapping?.square_catalog_discount_id) {
    currentLabel = discounts.find((d) => d.id === mapping.square_catalog_discount_id)?.name ?? null;
  }

  return (
    <>
      <div className="fixed inset-0 z-30 bg-black/40" onClick={onClose} aria-hidden="true" />
      <div className="fixed inset-y-0 right-0 z-40 w-[400px] bg-canvas border-l border-line shadow-2xl flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-line">
          <div>
            <p className="text-xs text-muted uppercase tracking-wide">Export Settings</p>
            <p className="text-sm font-semibold text-primary mt-0.5">
              {rowLabel} · {partnerName}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-muted hover:text-strong transition-colors text-lg leading-none"
            aria-label="Close drawer"
          >
            ×
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {currentLabel && (
            <div className="rounded-lg border border-success-border/40 bg-success-surface/20 px-3 py-2">
              <span className="text-xs text-success">✓ {currentLabel}</span>
            </div>
          )}
          <div className="space-y-2">
            {drawerKind === "catalog" ? (
              <SquareCatalogSelect
                key={pickerKey}
                items={items}
                itemId={pendingItemId}
                variationId={pendingVariationId}
                onChange={(itemId, variationId) => {
                  setPendingItemId(itemId);
                  setPendingVariationId(variationId);
                }}
              />
            ) : (
              <SquareDiscountSelect
                key={pickerKey}
                discounts={discounts}
                value={pendingDiscountId}
                onChange={(id) => setPendingDiscountId(id)}
              />
            )}
            {hasPending && (
              <button
                onClick={handleSave}
                disabled={saving}
                className="btn-primary w-full"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            )}
          </div>
          {error && <p className="text-xs text-danger">{error}</p>}
        </div>
      </div>
    </>
  );
}

type SelectedCell =
  | { kind: "packaging_fee"; vc: VolumeClass; partnerId: string | null }
  | { kind: "service"; serviceType: ServiceType; mappingKind: "catalog" | "discount"; rowLabel: string; partnerId: string | null };

function ServiceMappingGrid() {
  const { data: mappings = [] } = useExportServiceMappingsQuery();
  const { data: partners = [] } = useContractPartnersQuery();
  const { data: catalog } = useExportSquareCatalogQuery();
  const { data: packagingItems = [] } = usePackagingQuery();
  const qc = useQueryClient();

  const [selected, setSelected] = useState<SelectedCell | null>(null);

  const items = catalog?.items ?? [];
  const discounts = catalog?.discounts ?? [];
  const feeRows = mappings.filter((m) => m.service_type === "packaging_fee");
  const volumeClasses = deriveVolumeClasses(packagingItems);

  function getPackagingFeeMapping(vc: VolumeClass, partnerId: string | null): ExportServiceMapping | null {
    const classItemIds = new Set(
      packagingItems
        .filter((pi) => pi.type === vc.piType && pi.volume_fl_oz === vc.volumeFlOz)
        .map((pi) => pi.id)
    );
    return (
      feeRows.find(
        (m) =>
          m.packaging_item_id !== null &&
          classItemIds.has(m.packaging_item_id) &&
          m.packaging_format === vc.format &&
          m.partner_id === partnerId
      ) ?? null
    );
  }

  function getServiceMapping(serviceType: ServiceType, partnerId: string | null): ExportServiceMapping | null {
    return mappings.find((m) => m.service_type === serviceType && m.partner_id === partnerId) ?? null;
  }

  function catalogLabel(mapping: ExportServiceMapping | null): string | null {
    if (!mapping?.square_catalog_item_id) return null;
    const item = items.find((i) => i.itemId === mapping.square_catalog_item_id);
    const variation = item?.variations.find((v) => v.variationId === mapping.square_catalog_variation_id);
    if (item && variation) return `${item.itemName} · ${variation.variationName}`;
    return mapping.display_name || null;
  }

  async function savePackagingFee(vc: VolumeClass, partnerId: string | null, patch: Record<string, unknown>) {
    const res = await fetch("/api/production/export-settings/packaging-fee-class", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: vc.piType, volume_fl_oz: vc.volumeFlOz, format: vc.format, partner_id: partnerId, display_name: "Packaging Fee", ...patch }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error((body as { error?: string }).error ?? `Save failed (${res.status})`);
    }
    await qc.invalidateQueries({ queryKey: queryKeys.production.exportServiceMappings() });
  }

  async function saveService(serviceType: ServiceType, partnerId: string | null, existing: ExportServiceMapping | null, displayName: string, patch: Record<string, unknown>) {
    const res = await fetch("/api/production/export-settings/service-mappings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: existing?.id, service_type: serviceType, partner_id: partnerId, display_name: displayName, ...patch }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error((body as { error?: string }).error ?? `Save failed (${res.status})`);
    }
    await qc.invalidateQueries({ queryKey: queryKeys.production.exportServiceMappings() });
  }

  const columns: { partnerId: string | null; label: string }[] = [
    { partnerId: null, label: "Default" },
    ...partners.map((p) => ({ partnerId: p.id, label: p.company_name })),
  ];

  // Group header rows + data rows as a flat array for tbody
  type TbodyEntry =
    | { type: "header"; key: string; label: string }
    | { type: "row"; key: string; rowLabel: string; getCell: (partnerId: string | null) => { label: string | null; onClick: () => void } };

  const entries: TbodyEntry[] = [
    { type: "header", key: "h-pf", label: "Packaging Fees" },
    ...volumeClasses.map((vc): TbodyEntry => ({
      type: "row",
      key: `pf|${vc.piType}|${vc.volumeFlOz}|${vc.format ?? ""}`,
      rowLabel: vc.label,
      getCell: (partnerId) => ({
        label: catalogLabel(getPackagingFeeMapping(vc, partnerId)),
        onClick: () => setSelected({ kind: "packaging_fee", vc, partnerId }),
      }),
    })),
    { type: "header", key: "h-svc", label: "Services" },
    ...SERVICE_ROWS.filter((r) => r.kind === "catalog").map((r): TbodyEntry => ({
      type: "row",
      key: r.serviceType,
      rowLabel: r.label,
      getCell: (partnerId) => ({
        label: getMappingLabel(r, getServiceMapping(r.serviceType, partnerId), items, discounts),
        onClick: () => setSelected({ kind: "service", serviceType: r.serviceType, mappingKind: "catalog", rowLabel: r.label, partnerId }),
      }),
    })),
    { type: "header", key: "h-disc", label: "Discounts" },
    ...SERVICE_ROWS.filter((r) => r.kind === "discount").map((r): TbodyEntry => ({
      type: "row",
      key: r.serviceType,
      rowLabel: r.label,
      getCell: (partnerId) => ({
        label: getMappingLabel(r, getServiceMapping(r.serviceType, partnerId), items, discounts),
        onClick: () => setSelected({ kind: "service", serviceType: r.serviceType, mappingKind: "discount", rowLabel: r.label, partnerId }),
      }),
    })),
  ];

  // Derive drawer props from selected
  const selectedPartnerName = selected?.partnerId
    ? (partners.find((p) => p.id === selected.partnerId)?.company_name ?? "Unknown")
    : "Default";

  let drawerLabel = "";
  let drawerKind: "catalog" | "discount" = "catalog";
  let drawerMapping: ExportServiceMapping | null = null;
  let drawerOnSave: ((patch: Record<string, unknown>) => Promise<void>) | null = null;

  if (selected?.kind === "packaging_fee") {
    drawerLabel = selected.vc.label;
    drawerMapping = getPackagingFeeMapping(selected.vc, selected.partnerId);
    drawerOnSave = (patch) => savePackagingFee(selected.vc, selected.partnerId, patch);
  } else if (selected?.kind === "service") {
    drawerLabel = selected.rowLabel;
    drawerKind = selected.mappingKind;
    drawerMapping = getServiceMapping(selected.serviceType, selected.partnerId);
    drawerOnSave = (patch) => saveService(selected.serviceType, selected.partnerId, drawerMapping, selected.rowLabel, patch);
  }

  return (
    <section>
      <h3 className="text-sm font-medium text-strong mb-3">Service Mappings &amp; Discounts</h3>
      <div className="overflow-x-auto overflow-y-auto max-h-[calc(100vh-300px)] rounded-lg border border-line">
        <table
          className="text-xs border-collapse"
          style={{ tableLayout: "fixed", width: "max-content", minWidth: "100%" }}
        >
          <colgroup>
            <col style={{ width: 180 }} />
            {columns.map((_, i) => <col key={i} style={{ width: 200 }} />)}
          </colgroup>
          <thead>
            <tr className="border-b border-line">
              <th className="sticky left-0 top-0 z-30 bg-surface px-4 py-2.5 text-left font-semibold text-secondary whitespace-nowrap">
                Service
              </th>
              {columns.map((col) => (
                <th
                  key={col.partnerId ?? "default"}
                  className="sticky top-0 z-20 bg-surface px-3 py-2.5 text-left font-medium text-secondary whitespace-nowrap"
                >
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) =>
              entry.type === "header" ? (
                <tr key={entry.key}>
                  <td
                    colSpan={columns.length + 1}
                    className="px-4 py-1 text-[10px] font-semibold uppercase tracking-widest text-faint bg-surface/40 border-b border-line/40"
                  >
                    {entry.label}
                  </td>
                </tr>
              ) : (
                <tr key={entry.key} className="border-b border-line/40 hover:bg-surface/20 transition-colors">
                  <td className="sticky left-0 z-10 bg-canvas px-4 py-2.5 font-medium text-strong whitespace-nowrap border-r border-line/40">
                    {entry.rowLabel}
                  </td>
                  {columns.map((col) => {
                    const cell = entry.getCell(col.partnerId);
                    return (
                      <td
                        key={col.partnerId ?? "default"}
                        className="px-3 py-2.5 cursor-pointer align-middle"
                        onClick={cell.onClick}
                      >
                        {cell.label ? (
                          <span
                            className="inline-block px-1.5 py-0.5 rounded text-[10px] bg-success-surface/30 border border-success-border/50 text-success break-words leading-4 max-w-[170px] truncate"
                            title={cell.label}
                          >
                            ✓ {cell.label}
                          </span>
                        ) : (
                          <span className="inline-block px-1.5 py-0.5 rounded text-[10px] border border-danger-border/40 text-danger bg-danger-surface/10 leading-4">
                            —
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              )
            )}
          </tbody>
        </table>
      </div>

      {selected && drawerOnSave && (
        <ServiceMappingDrawer
          rowLabel={drawerLabel}
          drawerKind={drawerKind}
          partnerName={selectedPartnerName}
          mapping={drawerMapping}
          items={items}
          discounts={discounts}
          onClose={() => setSelected(null)}
          onSave={drawerOnSave}
        />
      )}
    </section>
  );
}

function InvoiceTermsSection() {
  const { data } = useExportInvoiceDueDaysQuery();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<string>("");
  const [saving, setSaving] = useState(false);

  const days = data?.days ?? 30;

  async function save() {
    const value = Number(draft || days);
    if (!Number.isInteger(value) || value < 1 || value > 365) return;
    setSaving(true);
    await fetch("/api/production/export-settings/invoice-due-days", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ days: value }),
    });
    setDraft("");
    setSaving(false);
    await qc.invalidateQueries({ queryKey: queryKeys.production.exportInvoiceDueDays() });
  }

  return (
    <section>
      <h3 className="text-sm font-medium text-strong mb-2">Export Invoice Net Terms</h3>
      <p className="text-xs text-faint mb-2">
        Days from the draft date until an export invoice is due. Applies to every partner.
      </p>
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={1}
          max={365}
          value={draft !== "" ? draft : days}
          onChange={(e) => setDraft(e.target.value)}
          className="bg-surface-mid border border-line-strong rounded px-2 py-1 text-xs text-strong w-20"
        />
        <span className="text-xs text-muted">days</span>
        <button onClick={save} disabled={saving} className="btn-primary">
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </section>
  );
}

export default function ExportSettingsPanel() {
  return (
    <div className="flex flex-col gap-8">
      <InvoiceTermsSection />
      <ExciseRatesSection />
      <ServiceMappingGrid />
    </div>
  );
}
