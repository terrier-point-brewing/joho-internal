"use client";

import React, { useState, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { PackagingVariation, PackagingVariationFormat } from "../types";
import { Modal, Field, ModalActions } from "./shared";
import { usePackagingQuery, usePackagingVariationsQuery, useContractPartnersQuery, productionKeys } from "../hooks/queries";
import { CATEGORY_BADGE_CLASS as CC, KEG_TAG_BADGE } from "../lib/categoryColors";
import { useTableControls } from "@/app/components/ui/useTableControls";
import SearchInput from "@/app/components/ui/SearchInput";
import FilterChips from "@/app/components/ui/FilterChips";
import FilterBar from "@/app/components/ui/FilterBar";
import type { ControlsConfig } from "@/lib/table/types";
import { FORMATS, FORMAT_ORDER, needsPaktech, needsTray, needsBreaksInto } from "@/lib/production/packagingVariations";
import BulkCanVariationModal from "./BulkCanVariationModal";

const PKGVAR_CONTROLS: ControlsConfig<PackagingVariation> = {
  search: [{ param: "q", accessor: (v) => v.name }],
  filters: [
    { param: "type", accessor: (v) => v.container?.type ?? "" },
    { param: "format", matches: (v, sel) => sel.includes(v.container?.type === "keg" ? "loose" : v.format) },
    { param: "partner", matches: (v, sel) => sel.some((s) => (s === "generic" ? v.partner_id === null : v.partner_id === s)) },
  ],
};

const TYPE_OPTIONS = [
  { value: "keg", label: "Keg", className: KEG_TAG_BADGE },
  { value: "can", label: "Can" },
];
const FORMAT_OPTIONS = FORMATS.map((f) => ({ value: f.value, label: f.label }));

const EMPTY_FORM = {
  container_id: "",
  format: "loose" as PackagingVariationFormat,
  lid_id: "",
  paktech_id: "",
  tray_id: "",
  label_id: "",
  partner_id: "",
  breaks_into_variation_id: "",
  name: "",
  is_labeled: false,
};

type FormState = typeof EMPTY_FORM;

const COMPONENT_COLORS = {
  lid:        "border-line-subtle bg-surface-mid/60 text-body",
  paktech:    CC.purple,
  tray:       "border-accent-border bg-accent-muted/30 text-accent-soft",
  label:      "border-info-border bg-info-surface/30 text-info",
  breaksInto: CC.amber,
} as const;

function ComponentPill({ name, type }: { name: string; type: keyof typeof COMPONENT_COLORS }) {
  return (
    <span className={`text-xs px-1.5 py-0.5 rounded border whitespace-nowrap ${COMPONENT_COLORS[type]}`}>
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
  const [showInactive,  setShowInactive]  = useState(false);

  // Modal state
  const [showModal,     setShowModal]     = useState(false);
  const [showBulkModal, setShowBulkModal] = useState(false);
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
      { value: "generic", label: "Generic" },
      ...Array.from(seen.entries()).map(([id, name]) => ({ value: id, label: name })),
    ];
  }, [variations]);

  const hasPartnerVariants = partnerChipOptions.length > 1;

  // A case's "breaks into" target must be a 4-pack/6-pack sibling sharing its
  // can-identity (container + lid + label + partner) — mirrors validateBreaksInto.
  const caseBreakOptions = useMemo(() => {
    if (form.format !== "case") return [];
    const wantLabelId = form.is_labeled ? (form.label_id || null) : null;
    return variations.filter((v) =>
      (v.format === "4-pack" || v.format === "6-pack") &&
      v.container_id === form.container_id &&
      (v.lid_id ?? null) === (form.lid_id || null) &&
      (v.label_id ?? null) === wantLabelId &&
      (v.partner_id ?? null) === (form.partner_id || null)
    );
  }, [variations, form.format, form.container_id, form.lid_id, form.label_id, form.is_labeled, form.partner_id]);

  // showInactive pre-filters the input set; search/type/format/partner run through the shared hook.
  const base = useMemo(
    () => (showInactive ? variations : variations.filter((v) => v.is_active)),
    [variations, showInactive],
  );
  const { rows: matched, search, filters, setSearch, setFilter, reset, activeCount } =
    useTableControls(base, PKGVAR_CONTROLS);

  // Fixed keg-first → format-order → name ordering is intentional — preserved verbatim,
  // applied after the shared hook's search/filter pass (no SortableTh; not user-configurable).
  const displayed = useMemo(() => {
    return [...matched].sort((a, b) => {
      const ta = a.container?.type === "keg" ? 0 : 1;
      const tb = b.container?.type === "keg" ? 0 : 1;
      if (ta !== tb) return ta - tb;
      const fa = FORMAT_ORDER.indexOf(a.container?.type === "keg" ? "loose" : a.format);
      const fb = FORMAT_ORDER.indexOf(b.container?.type === "keg" ? "loose" : b.format);
      if (fa !== fb) return fa - fb;
      return a.name.localeCompare(b.name);
    });
  }, [matched]);

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
      breaks_into_variation_id: v.breaks_into_variation_id ?? "",
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
        if (!needsBreaksInto(patch.format)) next.breaks_into_variation_id = "";
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
        next.breaks_into_variation_id = "";
      }
      if (patch.is_labeled === false) next.label_id = "";
      // Any change to the can-identity (label/partner) invalidates a previously
      // picked sibling — the case-break-into pool is keyed on that identity.
      if (patch.label_id !== undefined || patch.is_labeled !== undefined || patch.partner_id !== undefined) {
        next.breaks_into_variation_id = "";
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
        label_id: form.is_labeled ? (form.label_id || null) : null,
        partner_id: form.partner_id || null,
        breaks_into_variation_id: form.breaks_into_variation_id || null,
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
        <p className="text-xs text-muted">
          Strictly-defined packaging combinations — container + format + specific components. Used by Recipes to declare which variations they&apos;re packaged as.
        </p>
        <div className="flex gap-2 shrink-0">
          <button onClick={() => setShowBulkModal(true)} className="btn-secondary">Bulk Create</button>
          <button onClick={openNew} className="btn-primary">+ Add Variation</button>
        </div>
      </div>

      {/* Search + filters */}
      <div className="mb-3 space-y-2">
        <div className="flex items-center gap-3">
          <FilterBar activeCount={activeCount} onClear={reset}>
            <SearchInput value={search.q ?? ""} onChange={(v) => setSearch("q", v)} placeholder="Search variations…" />
            <FilterChips label="Type" options={TYPE_OPTIONS} value={filters.type ?? []} onChange={(v) => setFilter("type", v)} />
            <FilterChips label="Format" options={FORMAT_OPTIONS} value={filters.format ?? []} onChange={(v) => setFilter("format", v)} />
            {hasPartnerVariants && (
              <FilterChips label="Partner" options={partnerChipOptions} value={filters.partner ?? []} onChange={(v) => setFilter("partner", v)} />
            )}
          </FilterBar>
          <label className="flex items-center gap-1.5 text-xs text-muted cursor-pointer select-none shrink-0">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              className="rounded"
            />
            Show inactive
          </label>
        </div>
      </div>

      {/* Result count */}
      {(activeCount > 0 || showInactive) && (
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs text-muted">
            {displayed.length} of {variations.length} variation{variations.length !== 1 ? "s" : ""}
          </span>
        </div>
      )}

      {/* Table */}
      {variations.length === 0 ? (
        <p className="text-faint text-sm">No packaging variations yet.</p>
      ) : displayed.length === 0 ? (
        <p className="text-faint text-sm">No variations match the current filters.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface/50 text-left">
                <th className="px-3 py-2.5 text-xs font-medium text-muted">Container</th>
                <th className="px-3 py-2.5 text-xs font-medium text-muted">Name</th>
                <th className="px-3 py-2.5 text-xs font-medium text-muted">Format</th>
                <th className="px-3 py-2.5 text-xs font-medium text-muted">Components</th>
                <th className="px-3 py-2.5 text-xs font-medium text-muted">Partner</th>
                <th className="px-3 py-2.5 text-xs font-medium text-muted"></th>
              </tr>
            </thead>
            <tbody>
              {displayed.map((v, i) => {
                const vIsKeg = v.container?.type === "keg";
                const formatLabel = vIsKeg ? "Keg" : (FORMATS.find((f) => f.value === v.format)?.label ?? v.format);
                const hasComponents = v.lid || v.paktech || v.tray || v.label || v.breaks_into;
                return (
                  <tr
                    key={v.id}
                    className={`border-b border-line/60 ${
                      !v.is_active ? "opacity-50" : i % 2 !== 0 ? "bg-surface/30" : ""
                    }`}
                  >
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-1.5">
                        {vIsKeg ? (
                          <span className={`text-xs px-1.5 py-0.5 rounded ${KEG_TAG_BADGE} font-medium uppercase shrink-0`}>Keg</span>
                        ) : (
                          <span className="text-xs px-1.5 py-0.5 rounded border border-info-border bg-info-surface/30 text-info font-medium uppercase shrink-0">Can</span>
                        )}
                        <span className="text-secondary text-xs">{v.container?.name ?? "—"}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-strong font-medium text-xs">{v.name}</td>
                    <td className="px-3 py-2.5 text-secondary text-xs">{formatLabel}</td>
                    <td className="px-3 py-2.5">
                      {hasComponents ? (
                        <div className="flex flex-wrap gap-1">
                          {v.lid        && <ComponentPill name={v.lid.name}                       type="lid" />}
                          {v.paktech    && <ComponentPill name={v.paktech.name}                   type="paktech" />}
                          {v.tray       && <ComponentPill name={v.tray.name}                      type="tray" />}
                          {v.label      && <ComponentPill name={v.label.name}                     type="label" />}
                          {v.breaks_into && <ComponentPill name={`→ ${v.breaks_into.name}`}        type="breaksInto" />}
                        </div>
                      ) : (
                        <span className="text-faint">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-secondary text-xs">{v.contract_brewing_partners?.company_name ?? "Generic"}</td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap">
                      <button onClick={() => openEdit(v)} className="text-xs text-secondary hover:text-strong mr-3">Edit</button>
                      <button onClick={() => handleDelete(v)} aria-label="Delete variation" className="text-xs text-faint hover:text-danger">Delete</button>
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
              <p className="text-xs text-muted">
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
                {needsBreaksInto(form.format) && (
                  <Field
                    label="Breaks Into"
                    required
                    hint="Which pack size this case is assembled from — set the lid/label/partner above first so the matching 4-pack/6-pack siblings show up here."
                  >
                    <select className="inp w-full" value={form.breaks_into_variation_id} onChange={(e) => updateForm({ breaks_into_variation_id: e.target.value })} required>
                      <option value="">Select…</option>
                      {caseBreakOptions.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                    </select>
                    {caseBreakOptions.length === 0 && (
                      <p className="text-xs text-muted mt-1">
                        No matching 4-pack/6-pack variation yet for this container/lid/label/partner combination — create that variation first.
                      </p>
                    )}
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
                      <span className="text-sm text-body">Printed Can</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio" name="can_type" value="labeled"
                        checked={form.is_labeled}
                        onChange={() => updateForm({ is_labeled: true })}
                      />
                      <span className="text-sm text-body">Labeled Can</span>
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
            {error && <p className="text-xs text-danger">{error}</p>}
            <ModalActions submitting={submitting} onCancel={() => setShowModal(false)} label={editingId ? "Save" : "Create"} />
          </form>
        </Modal>
      )}

      {showBulkModal && (
        <BulkCanVariationModal
          packaging={packaging}
          partners={partners}
          variations={variations}
          onClose={() => setShowBulkModal(false)}
          onCreated={onRefresh}
        />
      )}
    </>
  );
}
