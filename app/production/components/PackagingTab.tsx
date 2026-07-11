"use client";

import React, { useState } from "react";
import { formatCurrency, formatNumber } from "@/lib/format";
import { useQueryClient } from "@tanstack/react-query";
import { PackagingItem, PackagingItemType, PackagingAdjustmentType } from "../types";
import { Modal, Field, ModalActions } from "./shared";
import { usePackagingQuery, useContractPartnersQuery, useSuppliersQuery, productionKeys } from "../hooks/queries";
import { useUserRole } from "@/lib/hooks/useUserRole";
import { fmtUsd } from "@/lib/utils/formatting";
import { CATEGORY_BADGE_CLASS as CC } from "../lib/categoryColors";
import { useTableControls } from "@/app/components/ui/useTableControls";
import SearchInput from "@/app/components/ui/SearchInput";
import FilterChips from "@/app/components/ui/FilterChips";
import FilterBar from "@/app/components/ui/FilterBar";
import type { ControlsConfig } from "@/lib/table/types";

const PKG_ADJ_TYPES: { value: PackagingAdjustmentType; label: string; hint: string; sign: "positive" | "negative" | "count" }[] = [
  { value: "received",        label: "Received",        hint: "Stock received from supplier", sign: "positive" },
  { value: "used",            label: "Used",            hint: "Manually recorded usage",      sign: "negative" },
  { value: "waste",           label: "Waste / Loss",    hint: "Damaged or written off",       sign: "negative" },
  { value: "inventory_count", label: "Inventory Count", hint: "Set actual stock total",       sign: "count"    },
];

const TYPE_META: Record<PackagingItemType, { label: string; color: string }> = {
  keg:     { label: "Keg",     color: CC.orange },
  can:     { label: "Can",     color: CC.blue },
  lid:     { label: "Lid",     color: CC.sky },
  paktech: { label: "PakTech", color: CC.purple },
  tray:    { label: "Tray",    color: CC.teal },
  label:   { label: "Label",   color: CC.rose },
};

const TYPES = Object.keys(TYPE_META) as PackagingItemType[];

const PACKAGING_CONTROLS: ControlsConfig<PackagingItem> = {
  search: [{ param: "q", accessor: (p) => p.name }],
  filters: [{ param: "type", accessor: (p) => p.type }],
};

const TYPE_OPTIONS = TYPES.map((t) => ({
  value: t,
  label: TYPE_META[t].label,
  className: TYPE_META[t].color,
}));

const EMPTY_FORM = {
  type: "keg" as PackagingItemType,
  name: "",
  partner_id: "",
  supplier_id: "",
  unit_cost: "",
  volume_fl_oz: "",
  can_count: "",
  is_default: false,
};

type FormState = typeof EMPTY_FORM;

function needsVolume(t: PackagingItemType)    { return t === "keg" || t === "can"; }
function needsCanCount(t: PackagingItemType)  { return t === "paktech" || t === "tray"; }

function partnerName(item: PackagingItem): string | null {
  return item.contract_brewing_partners?.company_name ?? null;
}
function supplierName(item: PackagingItem): string | null {
  return item.suppliers?.company_name ?? null;
}

export default function PackagingTab() {
  const qc = useQueryClient();
  const { role } = useUserRole();
  const isAdmin = role === "admin";
  const { data: packaging = [] } = usePackagingQuery();
  const { data: partners = [] } = useContractPartnersQuery();
  const { data: suppliers = [] } = useSuppliersQuery();
  const onRefresh = () => qc.invalidateQueries({ queryKey: productionKeys.packaging });

  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);

  // Search + type filter (URL-synced; prefixed since this route hosts sibling tabs)
  const { rows: visiblePackaging, search, filters, setSearch, setFilter, reset, activeCount } =
    useTableControls(packaging, PACKAGING_CONTROLS, { prefix: "pkg_" });

  // Adjustment state
  const [adjItem, setAdjItem] = useState<PackagingItem | null>(null);
  const [adjType, setAdjType] = useState<PackagingAdjustmentType>("received");
  const [adjQty, setAdjQty] = useState("");
  const [adjCost, setAdjCost] = useState("");
  const [adjShipping, setAdjShipping] = useState("");
  const [adjNote, setAdjNote] = useState("");
  const [adjSubmitting, setAdjSubmitting] = useState(false);


  function openAdj(item: PackagingItem) {
    setAdjItem(item); setAdjType("received"); setAdjQty(""); setAdjCost(""); setAdjShipping(""); setAdjNote("");
  }

  async function handleAdjSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!adjItem) return;
    setAdjSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        packaging_item_id: adjItem.id,
        type: adjType,
        note: adjNote || null,
      };
      if (adjType === "inventory_count") {
        body.new_total = parseFloat(adjQty);
      } else {
        body.quantity = parseFloat(adjQty);
      }
      if (adjType === "received" && adjCost !== "") body.purchase_cost = parseFloat(adjCost);
      if (adjType === "received" && adjShipping !== "") body.shipping_cost = parseFloat(adjShipping);

      const res = await fetch("/api/production/packaging-adjustments", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      setAdjItem(null);
      await onRefresh();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Error");
    } finally {
      setAdjSubmitting(false);
    }
  }

  function openNew() { setForm(EMPTY_FORM); setEditingId(null); setShowModal(true); }

  function openEdit(item: PackagingItem) {
    setForm({
      type:        item.type,
      name:        item.name,
      partner_id:  item.partner_id  ?? "",
      supplier_id: item.supplier_id ?? "",
      unit_cost:   item.unit_cost != null ? String(item.unit_cost) : "",
      volume_fl_oz: item.volume_fl_oz != null ? String(item.volume_fl_oz) : "",
      can_count:   item.can_count != null ? String(item.can_count) : "",
      is_default:  item.is_default,
    });
    setEditingId(item.id);
    setShowModal(true);
  }

  async function toggleDefault(item: PackagingItem) {
    const newDefault = !item.is_default;
    await fetch(`/api/production/packaging/${item.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: item.type, name: item.name,
        partner_id: item.partner_id || null,
        supplier_id: item.supplier_id || null,
        unit_cost: item.unit_cost, volume_fl_oz: item.volume_fl_oz,
        can_count: item.can_count, is_default: newDefault,
      }),
    });
    await onRefresh();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const payload = {
        type:        form.type,
        name:        form.name,
        partner_id:  form.partner_id  || null,
        supplier_id: form.supplier_id || null,
        unit_cost:   form.unit_cost ? parseFloat(form.unit_cost) : null,
        volume_fl_oz: needsVolume(form.type) && form.volume_fl_oz ? parseFloat(form.volume_fl_oz) : null,
        can_count:   needsCanCount(form.type) && form.can_count ? parseInt(form.can_count) : null,
        is_default:  form.is_default,
      };
      const res = editingId
        ? await fetch(`/api/production/packaging/${editingId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
        : await fetch("/api/production/packaging",               { method: "POST",  headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      setShowModal(false);
      await onRefresh();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Error");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(item: PackagingItem) {
    if (!confirm(`Delete "${item.name}"?`)) return;
    await fetch(`/api/production/packaging/${item.id}`, { method: "DELETE" });
    await onRefresh();
  }

  const grouped = TYPES.reduce<Record<PackagingItemType, PackagingItem[]>>((acc, t) => {
    acc[t] = visiblePackaging.filter((p) => p.type === t);
    return acc;
  }, {} as Record<PackagingItemType, PackagingItem[]>);

  return (
    <>
      {/* Search + type filter + Add Item inline */}
      <div className="flex items-center justify-between gap-2 mb-4 flex-wrap">
        <FilterBar activeCount={activeCount} onClear={reset}>
          <SearchInput
            value={search.q ?? ""}
            onChange={(v) => setSearch("q", v)}
            placeholder="Search packaging…"
          />
          <FilterChips
            label="Type"
            options={TYPE_OPTIONS}
            value={filters.type ?? []}
            onChange={(v) => setFilter("type", v)}
          />
        </FilterBar>
        <button onClick={openNew} className="btn-amber shrink-0">+ Add Item</button>
      </div>

      {packaging.length === 0 ? (
        <p className="text-faint text-sm">No packaging items yet.</p>
      ) : visiblePackaging.length === 0 ? (
        <p className="text-faint text-sm">No packaging matches the current filters.</p>
      ) : (
        <div className="space-y-6">
          {TYPES.map((t) => {
            const items = grouped[t];
            if (items.length === 0) return null;
            const meta = TYPE_META[t];
            return (
              <div key={t}>
                <div className="flex items-center gap-2 mb-2">
                  <span className={`text-xs px-2 py-px rounded border ${meta.color}`}>{meta.label}</span>
                  <span className="text-xs text-faint">{items.length} item{items.length !== 1 ? "s" : ""}</span>
                </div>
                <div className="overflow-x-auto rounded-lg border border-line">
                  <table className="w-full text-sm table-fixed min-w-[680px]">
                    <colgroup>
                      <col style={{ width: "20%" }} />
                      <col style={{ width: "12%" }} />
                      <col style={{ width: "12%" }} />
                      <col style={{ width: "7%" }} />
                      <col style={{ width: "9%" }} />
                      <col style={{ width: "11%" }} />
                      <col style={{ width: "6%" }} />
                      <col style={{ width: "23%" }} />
                    </colgroup>
                    <thead>
                      <tr className="border-b border-line bg-surface/50 text-left">
                        <th className="px-3 py-2.5 text-xs font-medium text-muted whitespace-nowrap">Name</th>
                        <th className="px-3 py-2.5 text-xs font-medium text-muted whitespace-nowrap">Partner</th>
                        <th className="px-3 py-2.5 text-xs font-medium text-muted whitespace-nowrap">Supplier</th>
                        <th className="px-3 py-2.5 text-xs font-medium text-muted text-right whitespace-nowrap">Stock</th>
                        <th className="px-3 py-2.5 text-xs font-medium text-muted text-right whitespace-nowrap">Unit Cost</th>
                        <th className="px-3 py-2.5 text-xs font-medium text-muted text-right whitespace-nowrap">
                          {needsVolume(t) ? "Volume" : needsCanCount(t) ? "Can Count" : "Details"}
                        </th>
                        <th className="px-3 py-2.5 text-xs font-medium text-muted text-center whitespace-nowrap">Default</th>
                        <th className="px-3 py-2.5 text-xs font-medium text-muted"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((item, i) => (
                        <tr key={item.id} className={`border-b border-line/60 ${i % 2 !== 0 ? "bg-surface/30" : ""}`}>
                          <td className="px-3 py-2.5 text-strong font-medium truncate">{item.name}</td>
                          <td className="px-3 py-2.5 text-secondary truncate">{partnerName(item) ?? "—"}</td>
                          <td className="px-3 py-2.5 text-secondary truncate">{supplierName(item) ?? "—"}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums">
                            <span className={Number(item.stock_quantity) < 0 ? "text-danger" : "text-body"}>
                              {formatNumber(Number(item.stock_quantity))}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 text-secondary text-right tabular-nums whitespace-nowrap">
                            {item.unit_cost != null
                              ? formatCurrency(Number(item.unit_cost))
                              : "—"}
                          </td>
                          <td className="px-3 py-2.5 text-secondary text-right tabular-nums whitespace-nowrap">
                            {needsVolume(t)
                              ? (item.volume_fl_oz != null
                                  ? `${Number(item.volume_fl_oz).toLocaleString(undefined, { maximumFractionDigits: 1 })} oz`
                                  : "—")
                              : needsCanCount(t)
                              ? (item.can_count != null
                                  ? `${formatNumber(Number(item.can_count))} cans`
                                  : "—")
                              : "—"}
                          </td>
                          <td className="px-3 py-2.5 text-center">
                            <button
                              onClick={() => toggleDefault(item)}
                              title={item.is_default ? "Remove default" : "Set as default"}
                              className={`text-xs px-1.5 py-0.5 rounded border transition-colors ${
                                item.is_default
                                  ? "border-accent-border bg-accent-muted/30 text-accent-soft"
                                  : "border-line-strong text-faint hover:border-line-subtle hover:text-secondary"
                              }`}
                            >
                              {item.is_default ? "★" : "☆"}
                            </button>
                          </td>
                          <td className="px-3 py-2.5">
                            <div className="flex gap-1.5 justify-end items-center whitespace-nowrap text-disabled">
                              <button onClick={() => openAdj(item)} className="text-xs text-accent-emphasis hover:text-accent transition-colors font-medium">Adjust</button>
                              {isAdmin && (<><span aria-hidden>·</span>
                              <button onClick={() => openEdit(item)} className="text-xs text-muted hover:text-strong transition-colors">Edit</button></>)}
                              <span aria-hidden>·</span>
                              <button onClick={() => handleDelete(item)} className="text-xs text-faint hover:text-danger transition-colors">Del</button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showModal && (
        <Modal title={editingId ? "Edit Packaging Item" : "Add Packaging Item"} onClose={() => setShowModal(false)}>
          <form onSubmit={handleSubmit} className="space-y-4">
            <Field label="Type" required>
              <div className="flex flex-wrap gap-2">
                {TYPES.map((t) => (
                  <button key={t} type="button"
                    onClick={() => setForm((f) => ({ ...f, type: t, volume_fl_oz: "", can_count: "" }))}
                    className={`px-3 py-1.5 rounded border text-xs font-medium transition-colors ${
                      form.type === t
                        ? `border-current ${TYPE_META[t].color}`
                        : "border-line-strong bg-surface-mid/50 text-secondary hover:border-line-subtle"
                    }`}
                  >
                    {TYPE_META[t].label}
                  </button>
                ))}
              </div>
            </Field>

            <Field label="Name" required>
              <input className="inp" required value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            </Field>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Partner (contract brewer)">
                <select className="inp" value={form.partner_id}
                  onChange={(e) => setForm((f) => ({ ...f, partner_id: e.target.value }))}>
                  <option value="">— none —</option>
                  {partners.map((p) => <option key={p.id} value={p.id}>{p.company_name}</option>)}
                </select>
              </Field>
              <Field label="Supplier">
                <select className="inp" value={form.supplier_id}
                  onChange={(e) => setForm((f) => ({ ...f, supplier_id: e.target.value }))}>
                  <option value="">— none —</option>
                  {suppliers.map((s) => <option key={s.id} value={s.id}>{s.company_name}</option>)}
                </select>
              </Field>
            </div>

            <Field label="Unit Cost ($)">
              <input type="number" step="0.01" min="0" className="inp" placeholder="0.00" value={form.unit_cost}
                onChange={(e) => setForm((f) => ({ ...f, unit_cost: e.target.value }))} />
            </Field>
            <div className="rounded bg-accent-muted/20 border border-accent-border/40 px-3 py-2 text-xs text-accent-soft">
              Unit cost must be the <strong>landed cost</strong> — include freight and shipping. Use stock adjustments (Received) to recalculate this automatically when new inventory arrives.
            </div>

            {needsVolume(form.type) && (
              <Field label="Volume (fl oz)" required>
                <div className="flex items-center gap-2">
                  <input type="number" step="0.1" min="0" className="inp w-40" placeholder="e.g. 1984" required value={form.volume_fl_oz}
                    onChange={(e) => setForm((f) => ({ ...f, volume_fl_oz: e.target.value }))} />
                  <span className="text-muted text-sm">fl oz</span>
                  {form.volume_fl_oz && (
                    <span className="text-faint text-xs">
                      = {(parseFloat(form.volume_fl_oz) / 128).toFixed(2)} gal
                      / {(parseFloat(form.volume_fl_oz) / 3968).toFixed(4)} BBL
                    </span>
                  )}
                </div>
              </Field>
            )}

            {needsCanCount(form.type) && (
              <Field label="Can count" required>
                <div className="flex items-center gap-2">
                  <input type="number" min="1" className="inp w-40" placeholder="e.g. 24" required value={form.can_count}
                    onChange={(e) => setForm((f) => ({ ...f, can_count: e.target.value }))} />
                  <span className="text-muted text-sm">cans</span>
                </div>
              </Field>
            )}

            <div className="flex items-center gap-3 p-3 rounded bg-surface-mid/40 border border-line-strong">
              <input
                type="checkbox"
                id="is_default"
                checked={form.is_default}
                onChange={(e) => setForm((f) => ({ ...f, is_default: e.target.checked }))}
                className="w-4 h-4 accent-amber-500"
              />
              <label htmlFor="is_default" className="text-sm text-body cursor-pointer select-none">
                Set as default {TYPE_META[form.type].label}
                {form.type !== "keg" && <span className="text-faint text-xs ml-1">(replaces current default for this type)</span>}
                {form.type === "keg" && <span className="text-faint text-xs ml-1">(kegs can have multiple defaults)</span>}
              </label>
            </div>

            <ModalActions submitting={submitting} onCancel={() => setShowModal(false)}
              label={editingId ? "Save Changes" : "Add Item"} />
          </form>
        </Modal>
      )}

      {/* Adjustment modal */}
      {adjItem && (
        <Modal title={`Adjust Stock — ${adjItem.name}`} onClose={() => setAdjItem(null)}>
          <form onSubmit={handleAdjSubmit} className="space-y-4">
            <div className="p-3 bg-surface-mid/50 rounded text-sm grid grid-cols-2 gap-4">
              <div>
                <p className="text-xs text-muted mb-0.5">Current stock</p>
                <p className="text-primary font-medium">{Number(adjItem.stock_quantity).toLocaleString(undefined, { maximumFractionDigits: 0 })}</p>
              </div>
              <div>
                <p className="text-xs text-muted mb-0.5">Unit cost</p>
                <p className="text-primary font-medium">{adjItem.unit_cost != null ? fmtUsd(Number(adjItem.unit_cost)) : "—"}</p>
              </div>
            </div>

            <Field label="Adjustment Type" required>
              <div className="grid grid-cols-2 gap-2">
                {PKG_ADJ_TYPES.map((t) => (
                  <button key={t.value} type="button" onClick={() => setAdjType(t.value)}
                    className={`px-3 py-2 rounded border text-sm text-left transition-colors ${adjType === t.value ? "border-accent-border bg-accent-muted/30 text-accent-soft" : "border-line-strong bg-surface-mid/50 text-secondary hover:border-line-subtle"}`}>
                    <div className="font-medium">{t.label}</div>
                    <div className="text-xs opacity-70 mt-0.5">{t.hint}</div>
                  </button>
                ))}
              </div>
            </Field>

            <Field label={adjType === "inventory_count" ? "New Total" : "Quantity"} required>
              <input type="number" step="1" min="0" className="inp" placeholder={adjType === "inventory_count" ? "Enter new total" : "Enter quantity"}
                value={adjQty} required onChange={(e) => setAdjQty(e.target.value)} />
            </Field>

            {adjType === "received" && (
              <>
                <Field label="Purchase Cost ($ per unit)" required>
                  <input type="number" step="0.01" min="0" className="inp" placeholder="0.00"
                    required value={adjCost} onChange={(e) => setAdjCost(e.target.value)} />
                </Field>
                <Field label="Shipping Cost ($ total)" required>
                  <input type="number" step="0.01" min="0" className="inp" placeholder="0.00"
                    required value={adjShipping} onChange={(e) => setAdjShipping(e.target.value)} />
                  <p className="text-xs mt-1 text-muted">Enter 0 if no freight charge on this order.</p>
                </Field>
              </>
            )}

            <Field label="Note">
              <input className="inp" value={adjNote} onChange={(e) => setAdjNote(e.target.value)} />
            </Field>

            <ModalActions submitting={adjSubmitting} onCancel={() => setAdjItem(null)} label="Record Adjustment" />
          </form>
        </Modal>
      )}
    </>
  );
}
