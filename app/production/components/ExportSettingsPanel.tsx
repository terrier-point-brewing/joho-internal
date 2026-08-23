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
import ExciseRatesSection from "@/app/settings/tax/filing/ExciseRatesSection";


const KEG_VOL_LABELS: Record<number, string> = { 1984: "1/2 BBL", 992: "1/4 BBL", 661: "1/6 BBL" };
const CAN_FORMAT_LABELS: Record<"loose" | "case", string> = { loose: "Loose Can", case: "Case" };

interface VolumeClass {
  piType: "keg" | "can";
  volumeFlOz: number;
  format: "loose" | "case" | null;
  label: string;
  /** Unbranded containers in this class — what the Default column prices. */
  blankIds: string[];
  /** partner_id → the containers printed for that partner in this class. */
  printedIdsByPartner: Map<string, string[]>;
}

type PackagingItemForClasses = {
  id: string;
  name: string;
  type: string;
  volume_fl_oz: number | null;
  partner_id: string | null;
};

/**
 * A packaging size/format, split into the containers each column prices.
 *
 * There are no per-container rows. A container printed for Argus is only ever
 * billed to Argus, so a "Printed for Argus" row would say exactly what the Argus
 * column already says. The split lives on the column axis instead: Default
 * prices the blanks, and a partner's cell prices that partner's own containers.
 */
function deriveVolumeClasses(packagingItems: PackagingItemForClasses[]): VolumeClass[] {
  const seen = new Map<string, VolumeClass>();
  for (const pi of packagingItems) {
    if ((pi.type !== "keg" && pi.type !== "can") || pi.volume_fl_oz == null) continue;
    const piType = pi.type as "keg" | "can";
    const vol = pi.volume_fl_oz;
    const formats = piType === "keg" ? [null] : (["loose", "case"] as const);
    for (const fmt of formats) {
      const k = `${piType}|${vol}|${fmt ?? ""}`;
      let vc = seen.get(k);
      if (!vc) {
        const label = piType === "keg"
          ? `${KEG_VOL_LABELS[vol] ?? `${vol} fl oz`} Keg`
          : `${vol}oz Can · ${CAN_FORMAT_LABELS[fmt as "loose" | "case"]}`;
        vc = {
          piType, volumeFlOz: vol, format: fmt as VolumeClass["format"], label,
          blankIds: [], printedIdsByPartner: new Map(),
        };
        seen.set(k, vc);
      }
      if (pi.partner_id) {
        const list = vc.printedIdsByPartner.get(pi.partner_id) ?? [];
        list.push(pi.id);
        vc.printedIdsByPartner.set(pi.partner_id, list);
      } else {
        vc.blankIds.push(pi.id);
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

/**
 * Which containers a given cell prices, and under whose partner_id.
 *
 * Default prices the blanks. A partner's cell prices that partner's printed
 * containers when they have any — those are theirs alone, so the mapping is
 * stored partner-agnostically and is found however the shipment is billed.
 * A partner with no printed container in this size (Fortnight cans a blank and
 * labels it) keeps the classic meaning: an override on the blank, for them only.
 */
function cellTarget(vc: VolumeClass, partnerId: string | null): {
  containerIds: string[];
  owner: string;
  mappingPartnerId: string | null;
} {
  if (!partnerId) return { containerIds: vc.blankIds, owner: "blank", mappingPartnerId: null };
  const printed = vc.printedIdsByPartner.get(partnerId);
  if (printed && printed.length > 0) {
    return { containerIds: printed, owner: partnerId, mappingPartnerId: null };
  }
  return { containerIds: vc.blankIds, owner: "blank", mappingPartnerId: partnerId };
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
      <button onClick={() => setOpen(true)} className="btn-secondary">
        + Add partner override
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <select value={partnerId} onChange={(e) => setPartnerId(e.target.value)}
        className="inp-sm w-auto">
        <option value="">— select partner —</option>
        {available.map((p) => <option key={p.id} value={p.id}>{p.company_name}</option>)}
      </select>
      <button onClick={() => { setOpen(false); setPartnerId(""); }} className="btn-secondary">
        Cancel
      </button>
      <button
        onClick={() => { if (partnerId) { onAdd(partnerId); setOpen(false); setPartnerId(""); } }}
        disabled={!partnerId}
        className="btn-primary"
      >
        Add
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

  /** The mapping for one container — the exact row the invoice builder looks up. */
  function getContainerFeeMapping(vc: VolumeClass, containerId: string, partnerId: string | null): ExportServiceMapping | null {
    return (
      feeRows.find(
        (m) =>
          m.packaging_item_id === containerId &&
          m.packaging_format === vc.format &&
          m.partner_id === partnerId
      ) ?? null
    );
  }

  /**
   * What a cell shows: a label only when every container it prices maps to the
   * same variation. Anything else is "Mixed" — an unmapped printed can is
   * exactly what makes an export invoice throw, so it must never hide behind a
   * sibling that happens to be mapped.
   */
  function summariseCell(vc: VolumeClass, partnerId: string | null): { label: string | null; mixed: boolean } {
    const { containerIds, mappingPartnerId } = cellTarget(vc, partnerId);
    if (containerIds.length === 0) return { label: null, mixed: false };
    const labels = containerIds.map((id) => catalogLabel(getContainerFeeMapping(vc, id, mappingPartnerId)));
    const distinct = new Set(labels);
    if (distinct.size === 1) return { label: labels[0], mixed: false };
    return { label: null, mixed: true };
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
    const { owner, mappingPartnerId } = cellTarget(vc, partnerId);
    const res = await fetch("/api/production/export-settings/packaging-fee-class", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: vc.piType,
        volume_fl_oz: vc.volumeFlOz,
        owner,
        format: vc.format,
        partner_id: mappingPartnerId,
        display_name: "Packaging Fee",
        ...patch,
      }),
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
    | { type: "row"; key: string; rowLabel: string; getCell: (partnerId: string | null) => { label: string | null; mixed?: boolean; onClick: () => void } };

  const entries: TbodyEntry[] = [
    { type: "header", key: "h-pf", label: "Packaging Fees" },
    ...volumeClasses.map((vc): TbodyEntry => ({
      type: "row",
      key: `pf|${vc.piType}|${vc.volumeFlOz}|${vc.format ?? ""}`,
      rowLabel: vc.label,
      getCell: (partnerId) => {
        const { label, mixed } = summariseCell(vc, partnerId);
        return { label, mixed, onClick: () => setSelected({ kind: "packaging_fee", vc, partnerId }) };
      },
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
    const target = cellTarget(selected.vc, selected.partnerId);
    // Name the containers the cell actually prices, so it is never a guess
    // whether you are setting the blank's fee or a partner's printed one.
    drawerLabel = `${selected.vc.label} · ${target.owner === "blank" ? "unprinted" : "printed"}`;
    // Only show a current mapping when every container it prices agrees on one.
    const summary = summariseCell(selected.vc, selected.partnerId);
    drawerMapping = summary.label
      ? getContainerFeeMapping(selected.vc, target.containerIds[0], target.mappingPartnerId)
      : null;
    drawerOnSave = (patch) => savePackagingFee(selected.vc, selected.partnerId, patch);
  } else if (selected?.kind === "service") {
    drawerLabel = selected.rowLabel;
    drawerKind = selected.mappingKind;
    drawerMapping = getServiceMapping(selected.serviceType, selected.partnerId);
    drawerOnSave = (patch) => saveService(selected.serviceType, selected.partnerId, drawerMapping, selected.rowLabel, patch);
  }

  return (
    <section>
      <h3 className="text-sm font-medium text-strong mb-1">Service Mappings &amp; Discounts</h3>
      <p className="text-xs text-faint mb-3">
        Rows are what you&rsquo;re charging for; columns are who gets billed. For packaging fees,
        Default prices the unprinted container and a partner&rsquo;s cell prices their own printed
        one — or, if they have none in that size, overrides the unprinted price for them.
      </p>
      <div className="overflow-x-auto overflow-y-auto max-h-[calc(100vh-300px)] rounded-lg border border-line">
        <table
          className="text-xs border-collapse w-full"
          // Partner columns share whatever is left after the label column, so a
          // two-partner brewery fills the page instead of stranding half of it,
          // and a tenth partner still scrolls rather than crushing the others.
          style={{ tableLayout: "fixed", minWidth: 320 + columns.length * 200 }}
        >
          <colgroup>
            <col style={{ width: 320 }} />
            {columns.map((_, i) => <col key={i} style={{ width: `${100 / columns.length}%` }} />)}
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
                  <td
                    className="sticky left-0 z-10 bg-canvas px-4 py-2.5 font-medium text-strong whitespace-nowrap overflow-hidden text-ellipsis border-r border-line/40"
                    title={entry.rowLabel}
                  >
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
                            className="block w-fit max-w-full px-1.5 py-0.5 rounded text-[10px] bg-success-surface/30 border border-success-border/50 text-success leading-4 truncate"
                            title={cell.label}
                          >
                            ✓ {cell.label}
                          </span>
                        ) : cell.mixed ? (
                          <span
                            className="inline-block px-1.5 py-0.5 rounded text-[10px] border border-accent-border/50 bg-accent-muted/30 text-accent leading-4"
                            title="Containers in this class map differently, or some are unmapped — expand to see each one"
                          >
                            Mixed
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
          className="inp-sm w-20"
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
      {/* Forms read badly full-bleed, so they keep the old cap; the grid takes
          the whole page, which is what it needs once a few partners exist. */}
      <div className="max-w-3xl flex flex-col gap-8">
        <InvoiceTermsSection />
        <ExciseRatesSection />
      </div>
      <ServiceMappingGrid />
    </div>
  );
}
