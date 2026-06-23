"use client";

import React, { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { PackagingVariation, PackagingVariationFormat } from "../types";
import { Modal, Field, ModalActions } from "./shared";
import { usePackagingQuery, usePackagingVariationsQuery, useContractPartnersQuery, productionKeys } from "../hooks/queries";

const FORMATS: { value: PackagingVariationFormat; label: string }[] = [
  { value: "loose",   label: "Loose" },
  { value: "4-pack",  label: "4-Pack" },
  { value: "6-pack",  label: "6-Pack" },
  { value: "case",    label: "Case" },
];

function needsPaktech(format: PackagingVariationFormat) { return format === "4-pack" || format === "6-pack"; }
function needsTray(format: PackagingVariationFormat)     { return format === "case"; }

const EMPTY_FORM = {
  container_id: "",
  format: "loose" as PackagingVariationFormat,
  lid_id: "",
  paktech_id: "",
  tray_id: "",
  label_id: "",
  partner_id: "",
  name: "",
};

type FormState = typeof EMPTY_FORM;

export default function PackagingVariationsPanel() {
  const qc = useQueryClient();
  const { data: packaging = [] } = usePackagingQuery();
  const { data: variations = [] } = usePackagingVariationsQuery();
  const { data: partners = [] } = useContractPartnersQuery();
  const onRefresh = () => qc.invalidateQueries({ queryKey: productionKeys.packagingVariations });

  const containers = packaging.filter((p) => p.type === "keg" || p.type === "can");
  const lids       = packaging.filter((p) => p.type === "lid");
  const paktechs    = packaging.filter((p) => p.type === "paktech");
  const trays       = packaging.filter((p) => p.type === "tray");
  const labels      = packaging.filter((p) => p.type === "label");

  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function openNew() { setForm(EMPTY_FORM); setEditingId(null); setError(null); setShowModal(true); }

  function openEdit(v: PackagingVariation) {
    setForm({
      container_id: v.container_id,
      format: v.format,
      lid_id: v.lid_id ?? "",
      paktech_id: v.paktech_id ?? "",
      tray_id: v.tray_id ?? "",
      label_id: v.label_id ?? "",
      partner_id: v.partner_id ?? "",
      name: v.name,
    });
    setEditingId(v.id);
    setError(null);
    setShowModal(true);
  }

  function updateForm(patch: Partial<FormState>) {
    setForm((f) => {
      const next = { ...f, ...patch };
      if (patch.format) {
        if (!needsPaktech(patch.format)) next.paktech_id = "";
        if (!needsTray(patch.format)) next.tray_id = "";
      }
      return next;
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const payload = {
        container_id: form.container_id,
        format: form.format,
        lid_id: form.lid_id || null,
        paktech_id: form.paktech_id || null,
        tray_id: form.tray_id || null,
        label_id: form.label_id || null,
        partner_id: form.partner_id || null,
        name: form.name,
      };
      const res = editingId
        ? await fetch(`/api/production/packaging-variations/${editingId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
        : await fetch("/api/production/packaging-variations",               { method: "POST",  headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      setShowModal(false);
      await onRefresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Error");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(v: PackagingVariation) {
    if (!confirm(`Delete "${v.name}"?`)) return;
    await fetch(`/api/production/packaging-variations/${v.id}`, { method: "DELETE" });
    await onRefresh();
  }

  return (
    <>
      <div className="flex items-center justify-between gap-2 mb-4">
        <p className="text-xs text-zinc-500">
          Strictly-defined packaging combinations — container + format + specific components. Used by Recipes to declare which variations they're packaged as.
        </p>
        <button onClick={openNew} className="btn-amber shrink-0">+ Add Variation</button>
      </div>

      {variations.length === 0 ? (
        <p className="text-zinc-600 text-sm">No packaging variations yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 bg-zinc-900/50 text-left">
                <th className="px-3 py-2.5 text-xs font-medium text-zinc-500">Name</th>
                <th className="px-3 py-2.5 text-xs font-medium text-zinc-500">Container</th>
                <th className="px-3 py-2.5 text-xs font-medium text-zinc-500">Format</th>
                <th className="px-3 py-2.5 text-xs font-medium text-zinc-500">Components</th>
                <th className="px-3 py-2.5 text-xs font-medium text-zinc-500">Partner</th>
                <th className="px-3 py-2.5 text-xs font-medium text-zinc-500"></th>
              </tr>
            </thead>
            <tbody>
              {variations.map((v, i) => (
                <tr key={v.id} className={`border-b border-zinc-800/60 ${i % 2 !== 0 ? "bg-zinc-900/30" : ""}`}>
                  <td className="px-3 py-2.5 text-zinc-200 font-medium">{v.name}</td>
                  <td className="px-3 py-2.5 text-zinc-400">{v.container?.name ?? "—"}</td>
                  <td className="px-3 py-2.5 text-zinc-400">{FORMATS.find((f) => f.value === v.format)?.label ?? v.format}</td>
                  <td className="px-3 py-2.5 text-zinc-400 text-xs">
                    {[v.lid?.name, v.paktech?.name, v.tray?.name, v.label?.name].filter(Boolean).join(", ") || "—"}
                  </td>
                  <td className="px-3 py-2.5 text-zinc-400">{v.contract_brewing_partners?.company_name ?? "Generic"}</td>
                  <td className="px-3 py-2.5 text-right whitespace-nowrap">
                    <button onClick={() => openEdit(v)} className="text-xs text-zinc-400 hover:text-zinc-200 mr-3">Edit</button>
                    <button onClick={() => handleDelete(v)} className="text-xs text-zinc-600 hover:text-red-400">Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showModal && (
        <Modal title={editingId ? "Edit Variation" : "New Variation"} onClose={() => setShowModal(false)}>
          <form onSubmit={handleSubmit} className="space-y-3">
            <Field label="Name" required>
              <input className="inp w-full" value={form.name} onChange={(e) => updateForm({ name: e.target.value })} required />
            </Field>
            <Field label="Container" required>
              <select className="inp w-full" value={form.container_id} onChange={(e) => updateForm({ container_id: e.target.value })} required>
                <option value="">Select…</option>
                {containers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="Format" required>
              <select className="inp w-full" value={form.format} onChange={(e) => updateForm({ format: e.target.value as PackagingVariationFormat })}>
                {FORMATS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
              </select>
            </Field>
            <Field label="Lid">
              <select className="inp w-full" value={form.lid_id} onChange={(e) => updateForm({ lid_id: e.target.value })}>
                <option value="">None</option>
                {lids.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </Field>
            {needsPaktech(form.format) && (
              <Field label="PakTech" required>
                <select className="inp w-full" value={form.paktech_id} onChange={(e) => updateForm({ paktech_id: e.target.value })} required>
                  <option value="">Select…</option>
                  {paktechs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </Field>
            )}
            {needsTray(form.format) && (
              <Field label="Tray" required>
                <select className="inp w-full" value={form.tray_id} onChange={(e) => updateForm({ tray_id: e.target.value })} required>
                  <option value="">Select…</option>
                  {trays.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </Field>
            )}
            <Field label="Label">
              <select className="inp w-full" value={form.label_id} onChange={(e) => updateForm({ label_id: e.target.value })}>
                <option value="">None</option>
                {labels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </Field>
            <Field label="Partner" hint="Leave blank for a generic variation available to everyone">
              <select className="inp w-full" value={form.partner_id} onChange={(e) => updateForm({ partner_id: e.target.value })}>
                <option value="">Generic (no partner)</option>
                {partners.map((p) => <option key={p.id} value={p.id}>{p.company_name}</option>)}
              </select>
            </Field>
            {error && <p className="text-xs text-red-400">{error}</p>}
            <ModalActions submitting={submitting} onCancel={() => setShowModal(false)} label={editingId ? "Save" : "Create"} />
          </form>
        </Modal>
      )}
    </>
  );
}
