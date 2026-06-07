"use client";

import React, { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Recipe, ContractBrewingPartner, DistributionAllocation, PackagingItem, AllocationStatus } from "../../types";
import { fmtDateLong } from "@/lib/utils/formatting";
import { Modal, Field, ModalActions } from "../shared";
import { BBL_TO_FL_OZ as FL_OZ_PER_BBL } from "@/lib/constants/production";
import { usePackagingQuery, fetchJson } from "../../hooks/queries";

type AllocType = "bbl" | "keg" | "can";

interface FormState {
  recipe_id: string;
  alloc_type: AllocType;
  packaging_item_id: string;
  quantity: string;
  cadence: "one_time" | "recurring";
  delivery_date: string;
  start_date: string;
  recurrence: "weekly" | "biweekly" | "monthly";
  end_date: string;
  partner_id: string;
  notes: string;
  status: AllocationStatus;
}

const EMPTY: FormState = {
  recipe_id: "", alloc_type: "keg", packaging_item_id: "", quantity: "",
  cadence: "one_time", delivery_date: "", start_date: "", recurrence: "weekly",
  end_date: "", partner_id: "", notes: "", status: "active",
};

const STATUS_META: Record<AllocationStatus, { label: string; cls: string }> = {
  active:    { label: "Active",    cls: "bg-green-900/50 text-green-400 border-green-800" },
  paused:    { label: "Paused",    cls: "bg-zinc-800/80 text-zinc-400 border-zinc-700" },
  fulfilled: { label: "Fulfilled", cls: "bg-blue-900/50 text-blue-400 border-blue-800" },
  cancelled: { label: "Cancelled", cls: "bg-red-900/40 text-red-400 border-red-800" },
};

function StatusBadge({ status }: { status: AllocationStatus }) {
  const m = STATUS_META[status] ?? STATUS_META.active;
  return <span className={`text-xs px-1.5 py-0.5 rounded border font-medium ${m.cls}`}>{m.label}</span>;
}

function bblFromPackagingItem(item: PackagingItem, qty: number): number {
  return item.volume_fl_oz ? (qty * item.volume_fl_oz) / FL_OZ_PER_BBL : 0;
}

function AllocationModal({
  recipes, partners, existing, onClose, onDone,
}: {
  recipes: Recipe[];
  partners: ContractBrewingPartner[];
  existing?: DistributionAllocation;
  onClose: () => void;
  onDone: () => void;
}) {
  const isEdit = !!existing;
  const { data: packaging = [] } = usePackagingQuery();
  const [form, setForm] = useState<FormState>(existing ? {
    recipe_id: existing.recipe_id ?? "",
    alloc_type: (existing.unit === "bbl" ? "bbl" : existing.unit === "keg" ? "keg" : "can") as AllocType,
    packaging_item_id: existing.packaging_item_id ?? "",
    quantity: String(existing.quantity),
    cadence: existing.cadence,
    delivery_date: existing.delivery_date ?? "",
    start_date: existing.start_date ?? "",
    recurrence: existing.recurrence ?? "weekly",
    end_date: existing.end_date ?? "",
    partner_id: existing.partner_id ?? "",
    notes: existing.notes ?? "",
    status: existing.status ?? "active",
  } : EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  const kegs = packaging.filter((p) => p.type === "keg");
  const cans = packaging.filter((p) => p.type === "can");
  const subItems = form.alloc_type === "keg" ? kegs : form.alloc_type === "can" ? cans : [];
  const selectedItem = packaging.find((p) => p.id === form.packaging_item_id) ?? null;
  const qty = parseFloat(form.quantity) || 0;
  const bblEquiv = selectedItem?.volume_fl_oz ? bblFromPackagingItem(selectedItem, qty) : null;

  function setAllocType(t: AllocType) { setForm((f) => ({ ...f, alloc_type: t, packaging_item_id: "" })); }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const packaging_value = form.alloc_type === "bbl" ? "draft" : form.alloc_type;
      const unit = form.alloc_type === "bbl" ? "bbl" : form.alloc_type;
      const body = {
        recipe_id: form.recipe_id || null,
        packaging: packaging_value,
        quantity: qty,
        unit,
        packaging_item_id: form.packaging_item_id || null,
        cadence: form.cadence,
        delivery_date: form.delivery_date || null,
        start_date: form.start_date || null,
        recurrence: form.recurrence,
        end_date: form.end_date || null,
        partner_id: form.partner_id || null,
        notes: form.notes || null,
        status: form.status,
      };
      const url = isEdit
        ? `/api/production/distribution-allocations?id=${existing!.id}`
        : "/api/production/distribution-allocations";
      const res = await fetch(url, {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      onDone(); onClose();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Error");
    } finally { setSubmitting(false); }
  }

  return (
    <Modal title={isEdit ? "Edit Allocation" : "New Allocation"} onClose={onClose} wide>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="Beer Style">
          <select className="inp" value={form.recipe_id} onChange={(e) => set("recipe_id", e.target.value)}>
            <option value="">— select a recipe —</option>
            {recipes.map((r) => <option key={r.id} value={r.id}>{r.beer_name}</option>)}
          </select>
        </Field>

        <Field label="Partner">
          <select className="inp" value={form.partner_id} onChange={(e) => set("partner_id", e.target.value)}>
            <option value="">— none —</option>
            {partners.map((p) => <option key={p.id} value={p.id}>{p.company_name}</option>)}
          </select>
        </Field>

        <Field label="Volume / Quantity" required>
          <div className="grid grid-cols-3 gap-2 mb-2">
            {(["bbl", "keg", "can"] as AllocType[]).map((t) => (
              <button key={t} type="button" onClick={() => setAllocType(t)}
                className={`px-3 py-2 rounded border text-sm transition-colors ${form.alloc_type === t ? "border-amber-600 bg-amber-900/30 text-amber-300" : "border-zinc-700 bg-zinc-800/50 text-zinc-400 hover:border-zinc-500"}`}>
                {t === "bbl" ? "BBL" : t === "keg" ? "Keg" : "Can"}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3">
            {(form.alloc_type === "keg" || form.alloc_type === "can") && (
              <Field label={form.alloc_type === "keg" ? "Keg Size" : "Can Size"} required>
                <select className="inp" value={form.packaging_item_id}
                  onChange={(e) => set("packaging_item_id", e.target.value)} required>
                  <option value="">— select —</option>
                  {subItems.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}{p.volume_fl_oz ? ` (${p.volume_fl_oz} fl oz)` : ""}</option>
                  ))}
                </select>
              </Field>
            )}
            <Field label={`Qty (${form.alloc_type === "bbl" ? "BBL" : form.alloc_type + "s"})`} required>
              <input type="number" step="0.01" min="0" className="inp" required
                value={form.quantity} onChange={(e) => set("quantity", e.target.value)} />
            </Field>
            {bblEquiv != null && bblEquiv > 0 && (
              <Field label="≈ BBL">
                <div className="inp text-zinc-400">{bblEquiv.toFixed(2)}</div>
              </Field>
            )}
          </div>
        </Field>

        <Field label="Cadence" required>
          <div className="grid grid-cols-2 gap-2">
            {(["one_time", "recurring"] as const).map((c) => (
              <button key={c} type="button" onClick={() => set("cadence", c)}
                className={`px-3 py-2 rounded border text-sm transition-colors ${form.cadence === c ? "border-amber-600 bg-amber-900/30 text-amber-300" : "border-zinc-700 bg-zinc-800/50 text-zinc-400 hover:border-zinc-500"}`}>
                {c === "one_time" ? "One-time" : "Recurring"}
              </button>
            ))}
          </div>
        </Field>

        {form.cadence === "one_time" ? (
          <Field label="Delivery Date" required>
            <input type="date" className="inp" required value={form.delivery_date}
              onChange={(e) => set("delivery_date", e.target.value)} />
          </Field>
        ) : (
          <div className="grid grid-cols-3 gap-3">
            <Field label="Start Date" required>
              <input type="date" className="inp" required value={form.start_date}
                onChange={(e) => set("start_date", e.target.value)} />
            </Field>
            <Field label="Frequency">
              <select className="inp" value={form.recurrence}
                onChange={(e) => set("recurrence", e.target.value as "weekly" | "biweekly" | "monthly")}>
                <option value="weekly">Weekly</option>
                <option value="biweekly">Biweekly</option>
                <option value="monthly">Monthly</option>
              </select>
            </Field>
            <Field label="End Date">
              <input type="date" className="inp" value={form.end_date}
                onChange={(e) => set("end_date", e.target.value)} />
            </Field>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Status">
            <select className="inp" value={form.status} onChange={(e) => set("status", e.target.value as AllocationStatus)}>
              {(["active", "paused", "fulfilled", "cancelled"] as AllocationStatus[]).map((s) => (
                <option key={s} value={s}>{STATUS_META[s].label}</option>
              ))}
            </select>
          </Field>
          <Field label="Notes">
            <input className="inp" value={form.notes} onChange={(e) => set("notes", e.target.value)} />
          </Field>
        </div>

        <ModalActions submitting={submitting} onCancel={onClose} label={isEdit ? "Save Changes" : "Create Allocation"} />
      </form>
    </Modal>
  );
}

export default function DistributionTab({ recipes, partners }: { recipes: Recipe[]; partners: ContractBrewingPartner[] }) {
  const qc = useQueryClient();
  const { data: rows = [] } = useQuery({
    queryKey: ["production", "distribution-allocations"],
    queryFn: () => fetchJson<DistributionAllocation[]>("/api/production/distribution-allocations"),
  });
  const load = () => qc.invalidateQueries({ queryKey: ["production", "distribution-allocations"] });
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<DistributionAllocation | null>(null);

  async function handleDelete(id: string) {
    if (!confirm("Delete this allocation?")) return;
    const r = await fetch(`/api/production/distribution-allocations?id=${id}`, { method: "DELETE" });
    if (r.ok) load();
  }

  function pkgLabel(a: DistributionAllocation): string {
    if (a.unit === "bbl") return `${Number(a.quantity).toFixed(2)} BBL`;
    const name = a.packaging_items?.name ?? a.unit;
    return `${Number(a.quantity)} × ${name}`;
  }

  function scheduleLabel(a: DistributionAllocation): string {
    if (a.cadence === "one_time") return a.delivery_date ? fmtDateLong(a.delivery_date) : "—";
    const freq = a.recurrence ?? "—";
    const from = a.start_date ? fmtDateLong(a.start_date) : "—";
    const to = a.end_date ? ` → ${fmtDateLong(a.end_date)}` : "";
    return `${freq.charAt(0).toUpperCase() + freq.slice(1)} from ${from}${to}`;
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <p className="text-sm text-zinc-500">Committed purchase allocations by style and packaging. All are outflows from cold storage.</p>
        <button onClick={() => setShowModal(true)} className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white text-sm font-medium rounded transition-colors">+ New Allocation</button>
      </div>
      {rows.length === 0 ? (
        <p className="text-zinc-600 text-sm py-10 text-center">No allocations recorded yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 bg-zinc-900/50 text-left">
                {["Style", "Partner", "Quantity", "Schedule", "Status", "Notes", ""].map((h, i) => (
                  <th key={i} className="px-4 py-2.5 text-xs font-medium text-zinc-500">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((a, i) => (
                <tr key={a.id} className={`border-b border-zinc-800/60 ${i % 2 !== 0 ? "bg-zinc-900/30" : ""}`}>
                  <td className="px-4 py-2.5 text-zinc-100 font-medium">{a.recipes?.beer_name ?? "—"}</td>
                  <td className="px-4 py-2.5 text-zinc-400">{a.contract_brewing_partners?.company_name ?? "—"}</td>
                  <td className="px-4 py-2.5 text-zinc-300 tabular-nums">{pkgLabel(a)}</td>
                  <td className="px-4 py-2.5 text-zinc-400 text-xs whitespace-nowrap">{scheduleLabel(a)}</td>
                  <td className="px-4 py-2.5"><StatusBadge status={a.status ?? "active"} /></td>
                  <td className="px-4 py-2.5 text-zinc-500 text-xs max-w-[160px] truncate">{a.notes ?? "—"}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-3">
                      <button onClick={() => setEditing(a)} className="text-xs text-zinc-400 hover:text-zinc-200">Edit</button>
                      <button onClick={() => handleDelete(a.id)} className="text-xs text-red-400/80 hover:text-red-400">Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {showModal && <AllocationModal recipes={recipes} partners={partners} onClose={() => setShowModal(false)} onDone={load} />}
      {editing && <AllocationModal recipes={recipes} partners={partners} existing={editing} onClose={() => setEditing(null)} onDone={load} />}
    </div>
  );
}
