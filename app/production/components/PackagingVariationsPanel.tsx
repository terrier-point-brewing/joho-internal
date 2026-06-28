"use client";

import React, { useState, useMemo } from "react";
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

const FORMAT_ORDER: PackagingVariationFormat[] = ["loose", "4-pack", "6-pack", "case"];

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
  is_labeled: false,
};

type FormState = typeof EMPTY_FORM;

function Chips<T extends string>({
  label, options, value, onChange,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className="text-xs text-zinc-500 mr-0.5">{label}:</span>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`text-[11px] px-2 py-0.5 rounded border transition-colors ${
            value === o.value
              ? "border-amber-600 bg-amber-900/40 text-amber-300"
              : "border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-300"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const COMPONENT_COLORS = {
  lid:     "border-zinc-600 bg-zinc-800/60 text-zinc-300",
  paktech: "border-purple-700 bg-purple-900/30 text-purple-300",
  tray:    "border-amber-700 bg-amber-900/30 text-amber-300",
  label:   "border-blue-700 bg-blue-900/30 text-blue-300",
} as const;

function ComponentPill({ name, type }: { name: string; type: keyof typeof COMPONENT_COLORS }) {
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded border whitespace-nowrap ${COMPONENT_COLORS[type]}`}>
      {name}
    </span>
  );
}

export default function PackagingVariationsPanel() {
  const qc = useQueryClient();
  const { data: packaging = [] } = usePackagingQuery();
  const { data: variations = [] } = usePackagingVariationsQuery();
  const { data: partners = [] } = useContractPartnersQuery();
  const onRefresh = () => qc.invalidateQueries({ queryKey: productionKeys.packagingVariations });

  const containers = packaging.filter((p) => p.type === "keg" || p.type === "can");
  const lids       = packaging.filter((p) => p.type === "lid");
  const paktechs   = packaging.filter((p) => p.type === "paktech");
  const trays      = packaging.filter((p) => p.type === "tray");
  const labels     = packaging.filter((p) => p.type === "label");

  // Filter state
  const [search,        setSearch]        = useState("");
  const [filterType,    setFilterType]    = useState<"all" | "keg" | "can">("all");
  const [filterFormat,  setFilterFormat]  = useState<"all" | PackagingVariationFormat>("all");
  const [filterPartner, setFilterPartner] = useState("all");
  const [showInactive,  setShowInactive]  = useState(false);

  // Modal state
  const [showModal,   setShowModal]   = useState(false);
  const [editingId,   setEditingId]   = useState<string | null>(null);
  const [form,        setForm]        = useState<FormState>(EMPTY_FORM);
  const [submitting,  setSubmitting]  = useState(false);
  const [error,       setError]       = useState<string | null>(null);

  const containerType = containers.find((c) => c.id === form.container_id)?.type ?? null;
  const isKeg = containerType === "keg";

  // Partner options derived from the loaded variations (avoids showing partners with no records)
  const partnerChipOptions = useMemo<{ value: string; label: string }[]>(() => {
    const seen = new Map<string, string>();
    for (const v of variations) {
      if (v.partner_id && v.contract_brewing_partners?.company_name) {
        seen.set(v.partner_id, v.contract_brewing_partners.company_name);
      }
    }
    return [
      { value: "all",     label: "All" },
      { value: "generic", label: "Generic" },
      ...Array.from(seen.entries()).map(([id, name]) => ({ value: id, label: name })),
    ];
  }, [variations]);

  const hasPartnerVariants = partnerChipOptions.length > 2;

  const displayed = useMemo(() => {
    const q = search.trim().toLowerCase();
    return variations
      .filter((v) => {
        if (!showInactive && !v.is_active) return false;
        if (q && !v.name.toLowerCase().includes(q)) return false;
        if (filterType !== "all" && v.container?.type !== filterType) return false;
        if (filterFormat !== "all") {
          const eff = v.container?.type === "keg" ? "loose" : v.format;
          if (eff !== filterFormat) return false;
        }
        if (filterPartner === "generic" && v.partner_id !== null) return false;
        if (filterPartner !== "all" && filterPartner !== "generic" && v.partner_id !== filterPartner) return false;
        return true;
      })
      .sort((a, b) => {
        const ta = a.container?.type === "keg" ? 0 : 1;
        const tb = b.container?.type === "keg" ? 0 : 1;
        if (ta !== tb) return ta - tb;
        const fa = FORMAT_ORDER.indexOf(a.container?.type === "keg" ? "loose" : a.format);
        const fb = FORMAT_ORDER.indexOf(b.container?.type === "keg" ? "loose" : b.format);
        if (fa !== fb) return fa - fb;
        return a.name.localeCompare(b.name);
      });
  }, [variations, search, filterType, filterFormat, filterPartner, showInactive]);

  const hasActiveFilters = search || filterType !== "all" || filterFormat !== "all" || filterPartner !== "all";

  function clearFilters() {
    setSearch("");
    setFilterType("all");
    setFilterFormat("all");
    setFilterPartner("all");
  }

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
      is_labeled: !!v.label_id,
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
      if (patch.container_id !== undefined) {
        const type = containers.find((c) => c.id === patch.container_id)?.type;
        if (type === "keg") {
          next.format = "loose";
          next.lid_id = "";
          next.paktech_id = "";
          next.tray_id = "";
          next.label_id = "";
          next.is_labeled = false;
        }
      }
      if (patch.is_labeled === false) next.label_id = "";
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
        label_id: form.is_labeled ? (form.label_id || null) : null,
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
      {/* Header */}
      <div className="flex items-center justify-between gap-2 mb-4">
        <p className="text-xs text-zinc-500">
          Strictly-defined packaging combinations — container + format + specific components. Used by Recipes to declare which variations they&apos;re packaged as.
        </p>
        <button onClick={openNew} className="btn-amber shrink-0">+ Add Variation</button>
      </div>

      {/* Search + filters */}
      <div className="mb-3 space-y-2">
        <div className="flex items-center gap-3">
          <input
            type="search"
            placeholder="Search by name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="inp flex-1 max-w-xs text-sm"
          />
          <label className="flex items-center gap-1.5 text-xs text-zinc-500 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              className="rounded"
            />
            Show inactive
          </label>
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-1.5">
          <Chips
            label="Type"
            options={[
              { value: "all", label: "All" },
              { value: "keg", label: "Keg" },
              { value: "can", label: "Can" },
            ] as { value: "all" | "keg" | "can"; label: string }[]}
            value={filterType}
            onChange={(v) => { setFilterType(v); if (v === "keg") setFilterFormat("all"); }}
          />
          <Chips
            label="Format"
            options={[{ value: "all", label: "All" }, ...FORMATS] as { value: "all" | PackagingVariationFormat; label: string }[]}
            value={filterFormat}
            onChange={setFilterFormat}
          />
          {hasPartnerVariants && (
            <Chips
              label="Partner"
              options={partnerChipOptions}
              value={filterPartner}
              onChange={setFilterPartner}
            />
          )}
        </div>
      </div>

      {/* Result count + clear */}
      {(hasActiveFilters || showInactive) && (
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs text-zinc-500">
            {displayed.length} of {variations.length} variation{variations.length !== 1 ? "s" : ""}
          </span>
          {hasActiveFilters && (
            <button onClick={clearFilters} className="text-xs text-zinc-600 hover:text-zinc-400">
              Clear filters
            </button>
          )}
        </div>
      )}

      {/* Table */}
      {variations.length === 0 ? (
        <p className="text-zinc-600 text-sm">No packaging variations yet.</p>
      ) : displayed.length === 0 ? (
        <p className="text-zinc-600 text-sm">No variations match the current filters.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 bg-zinc-900/50 text-left">
                <th className="px-3 py-2.5 text-xs font-medium text-zinc-500">Container</th>
                <th className="px-3 py-2.5 text-xs font-medium text-zinc-500">Name</th>
                <th className="px-3 py-2.5 text-xs font-medium text-zinc-500">Format</th>
                <th className="px-3 py-2.5 text-xs font-medium text-zinc-500">Components</th>
                <th className="px-3 py-2.5 text-xs font-medium text-zinc-500">Partner</th>
                <th className="px-3 py-2.5 text-xs font-medium text-zinc-500"></th>
              </tr>
            </thead>
            <tbody>
              {displayed.map((v, i) => {
                const vIsKeg = v.container?.type === "keg";
                const formatLabel = vIsKeg ? "Keg" : (FORMATS.find((f) => f.value === v.format)?.label ?? v.format);
                const hasComponents = v.lid || v.paktech || v.tray || v.label;
                return (
                  <tr
                    key={v.id}
                    className={`border-b border-zinc-800/60 ${
                      !v.is_active ? "opacity-50" : i % 2 !== 0 ? "bg-zinc-900/30" : ""
                    }`}
                  >
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-1.5">
                        {vIsKeg ? (
                          <span className="text-[10px] px-1.5 py-0.5 rounded border border-orange-700 bg-orange-900/30 text-orange-300 font-medium uppercase shrink-0">Keg</span>
                        ) : (
                          <span className="text-[10px] px-1.5 py-0.5 rounded border border-blue-700 bg-blue-900/30 text-blue-300 font-medium uppercase shrink-0">Can</span>
                        )}
                        <span className="text-zinc-400 text-xs">{v.container?.name ?? "—"}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-zinc-200 font-medium">{v.name}</td>
                    <td className="px-3 py-2.5 text-zinc-400 text-xs">{formatLabel}</td>
                    <td className="px-3 py-2.5">
                      {hasComponents ? (
                        <div className="flex flex-wrap gap-1">
                          {v.lid     && <ComponentPill name={v.lid.name}     type="lid" />}
                          {v.paktech && <ComponentPill name={v.paktech.name} type="paktech" />}
                          {v.tray    && <ComponentPill name={v.tray.name}    type="tray" />}
                          {v.label   && <ComponentPill name={v.label.name}   type="label" />}
                        </div>
                      ) : (
                        <span className="text-zinc-600">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-zinc-400 text-xs">{v.contract_brewing_partners?.company_name ?? "Generic"}</td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap">
                      <button onClick={() => openEdit(v)} className="text-xs text-zinc-400 hover:text-zinc-200 mr-3">Edit</button>
                      <button onClick={() => handleDelete(v)} className="text-xs text-zinc-600 hover:text-red-400">Delete</button>
                    </td>
                  </tr>
                );
              })}
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
            {isKeg ? (
              <p className="text-xs text-zinc-500">
                Kegs are packaged loose — no format, lid, PakTech, tray, or label applies.
              </p>
            ) : (
              <>
                <Field label="Format" required>
                  <select className="inp w-full" value={form.format} onChange={(e) => updateForm({ format: e.target.value as PackagingVariationFormat })}>
                    {FORMATS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                  </select>
                </Field>
                <Field label="Lid" required>
                  <select className="inp w-full" value={form.lid_id} onChange={(e) => updateForm({ lid_id: e.target.value })} required>
                    <option value="">Select lid…</option>
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
                <Field label="Can Type" required>
                  <div className="flex gap-4">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio" name="can_type" value="printed"
                        checked={!form.is_labeled}
                        onChange={() => updateForm({ is_labeled: false })}
                      />
                      <span className="text-sm text-zinc-300">Printed Can</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio" name="can_type" value="labeled"
                        checked={form.is_labeled}
                        onChange={() => updateForm({ is_labeled: true })}
                      />
                      <span className="text-sm text-zinc-300">Labeled Can</span>
                    </label>
                  </div>
                </Field>
                {form.is_labeled && (
                  <Field label="Label" required>
                    <select className="inp w-full" value={form.label_id} onChange={(e) => updateForm({ label_id: e.target.value })} required>
                      <option value="">Select label…</option>
                      {labels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                    </select>
                  </Field>
                )}
              </>
            )}
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
