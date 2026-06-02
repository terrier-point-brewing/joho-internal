"use client";

import React, { useState } from "react";
import { PackagingItem, PackagingItemType } from "../types";
import { Modal, Field, ModalActions } from "./shared";

const TYPE_META: Record<PackagingItemType, { label: string; color: string }> = {
  keg:     { label: "Keg",     color: "bg-orange-900/60 text-orange-300 border-orange-700" },
  can:     { label: "Can",     color: "bg-blue-900/60 text-blue-300 border-blue-700" },
  lid:     { label: "Lid",     color: "bg-sky-900/60 text-sky-300 border-sky-700" },
  paktech: { label: "PakTech", color: "bg-purple-900/60 text-purple-300 border-purple-700" },
  tray:    { label: "Tray",    color: "bg-teal-900/60 text-teal-300 border-teal-700" },
};

const TYPES = Object.keys(TYPE_META) as PackagingItemType[];

const EMPTY_FORM = {
  type: "keg" as PackagingItemType,
  name: "",
  supplier: "",
  unit_cost: "",
  brewery: "",
  volume_fl_oz: "",
  can_count: "",
};

type FormState = typeof EMPTY_FORM;

function needsVolume(t: PackagingItemType) { return t === "keg" || t === "can"; }
function needsCanCount(t: PackagingItemType) { return t === "paktech" || t === "tray"; }

export default function PackagingTab({
  packaging,
  onRefresh,
}: {
  packaging: PackagingItem[];
  onRefresh: () => Promise<void>;
}) {
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [filterType, setFilterType] = useState<PackagingItemType | "all">("all");

  function openNew() {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setShowModal(true);
  }

  function openEdit(item: PackagingItem) {
    setForm({
      type: item.type,
      name: item.name,
      supplier: item.supplier ?? "",
      unit_cost: item.unit_cost != null ? String(item.unit_cost) : "",
      brewery: item.brewery ?? "",
      volume_fl_oz: item.volume_fl_oz != null ? String(item.volume_fl_oz) : "",
      can_count: item.can_count != null ? String(item.can_count) : "",
    });
    setEditingId(item.id);
    setShowModal(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const payload = {
        type: form.type,
        name: form.name,
        supplier: form.supplier || null,
        unit_cost: form.unit_cost ? parseFloat(form.unit_cost) : null,
        brewery: form.brewery || null,
        volume_fl_oz: needsVolume(form.type) && form.volume_fl_oz ? parseFloat(form.volume_fl_oz) : null,
        can_count: needsCanCount(form.type) && form.can_count ? parseInt(form.can_count) : null,
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

  const filtered = filterType === "all" ? packaging : packaging.filter((p) => p.type === filterType);

  // Group by type for display
  const grouped = TYPES.reduce<Record<PackagingItemType, PackagingItem[]>>((acc, t) => {
    acc[t] = filtered.filter((p) => p.type === t);
    return acc;
  }, {} as Record<PackagingItemType, PackagingItem[]>);

  return (
    <>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-medium text-zinc-100">Packaging</h2>
          <p className="text-sm text-zinc-500 mt-0.5">Kegs, cans, lids, carriers, and trays</p>
        </div>
        <button onClick={openNew} className="btn-amber">+ Add Item</button>
      </div>

      {/* Filter pills */}
      <div className="flex gap-2 mb-4 flex-wrap">
        <button
          onClick={() => setFilterType("all")}
          className={`text-xs px-2.5 py-1 rounded border transition-colors ${filterType === "all" ? "border-zinc-500 text-zinc-200 bg-zinc-800" : "border-zinc-700 text-zinc-500 hover:text-zinc-300"}`}
        >
          All
        </button>
        {TYPES.map((t) => (
          <button key={t}
            onClick={() => setFilterType(t)}
            className={`text-xs px-2.5 py-1 rounded border transition-colors ${filterType === t ? `border-current ${TYPE_META[t].color}` : "border-zinc-700 text-zinc-500 hover:text-zinc-300"}`}
          >
            {TYPE_META[t].label}
          </button>
        ))}
      </div>

      {packaging.length === 0 ? (
        <p className="text-zinc-600 text-sm">No packaging items yet. Add kegs, cans, lids, PakTechs, or trays.</p>
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
                  <span className="text-xs text-zinc-600">{items.length} item{items.length !== 1 ? "s" : ""}</span>
                </div>
                <div className="overflow-x-auto rounded-lg border border-zinc-800">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-zinc-800 bg-zinc-900/50 text-left">
                        <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Name</th>
                        <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Supplier</th>
                        <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Brewery</th>
                        <th className="px-4 py-2.5 text-xs font-medium text-zinc-500 text-right">Unit Cost</th>
                        {needsVolume(t) && <th className="px-4 py-2.5 text-xs font-medium text-zinc-500 text-right">Volume</th>}
                        {needsCanCount(t) && <th className="px-4 py-2.5 text-xs font-medium text-zinc-500 text-right">Can Count</th>}
                        <th className="px-4 py-2.5 text-xs font-medium text-zinc-500 w-20"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((item, i) => (
                        <tr key={item.id} className={`border-b border-zinc-800/60 ${i % 2 !== 0 ? "bg-zinc-900/30" : ""}`}>
                          <td className="px-4 py-2.5 text-zinc-200 font-medium">{item.name}</td>
                          <td className="px-4 py-2.5 text-zinc-400">{item.supplier ?? "—"}</td>
                          <td className="px-4 py-2.5 text-zinc-400">{item.brewery ?? "—"}</td>
                          <td className="px-4 py-2.5 text-zinc-400 text-right">
                            {item.unit_cost != null ? `$${Number(item.unit_cost).toFixed(2)}` : "—"}
                          </td>
                          {needsVolume(t) && (
                            <td className="px-4 py-2.5 text-zinc-400 text-right">
                              {item.volume_fl_oz != null ? `${item.volume_fl_oz} fl oz` : "—"}
                            </td>
                          )}
                          {needsCanCount(t) && (
                            <td className="px-4 py-2.5 text-zinc-400 text-right">
                              {item.can_count != null ? item.can_count : "—"}
                            </td>
                          )}
                          <td className="px-4 py-2.5">
                            <div className="flex gap-2 justify-end">
                              <button onClick={() => openEdit(item)} className="text-xs text-zinc-500 hover:text-zinc-200 transition-colors">Edit</button>
                              <button onClick={() => handleDelete(item)} className="text-xs text-zinc-600 hover:text-red-400 transition-colors">Delete</button>
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
                        : "border-zinc-700 bg-zinc-800/50 text-zinc-400 hover:border-zinc-500"
                    }`}
                  >
                    {TYPE_META[t].label}
                  </button>
                ))}
              </div>
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Name" required>
                <input className="inp" required value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
              </Field>
              <Field label="Supplier">
                <input className="inp" value={form.supplier}
                  onChange={(e) => setForm((f) => ({ ...f, supplier: e.target.value }))} />
              </Field>
              <Field label="Unit Cost ($)">
                <input type="number" step="0.01" min="0" className="inp" placeholder="0.00" value={form.unit_cost}
                  onChange={(e) => setForm((f) => ({ ...f, unit_cost: e.target.value }))} />
              </Field>
              <Field label="Brewery (contract partner)">
                <input className="inp" placeholder="Optional" value={form.brewery}
                  onChange={(e) => setForm((f) => ({ ...f, brewery: e.target.value }))} />
              </Field>
            </div>

            {needsVolume(form.type) && (
              <Field label="Volume (fl oz)" required>
                <div className="flex items-center gap-2">
                  <input type="number" step="0.1" min="0" className="inp w-40" placeholder="e.g. 1984" required value={form.volume_fl_oz}
                    onChange={(e) => setForm((f) => ({ ...f, volume_fl_oz: e.target.value }))} />
                  <span className="text-zinc-500 text-sm">fl oz</span>
                  {form.volume_fl_oz && (
                    <span className="text-zinc-600 text-xs">
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
                  <span className="text-zinc-500 text-sm">cans</span>
                </div>
              </Field>
            )}

            <ModalActions submitting={submitting} onCancel={() => setShowModal(false)}
              label={editingId ? "Save Changes" : "Add Item"} />
          </form>
        </Modal>
      )}
    </>
  );
}
