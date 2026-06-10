"use client";

import React, { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { Recipe, ContractBrewingPartner, Commitment, ContractRequestStatus } from "../../types";
import { fmtDateLong } from "@/lib/utils/formatting";
import { Modal, Field, ModalActions } from "../shared";
import { usePackagingQuery, fetchJson } from "../../hooks/queries";
import { BBL_TO_FL_OZ as FL_OZ_PER_BBL } from "@/lib/constants/production";

type AllocType = "bbl" | "keg" | "can";

interface FormState {
  recipe_id: string;
  partner_id: string;
  alloc_type: AllocType;
  packaging_item_id: string;
  packaging_qty: string;
  volume_bbl: string;
  cadence: "one_time" | "recurring";
  delivery_date: string;
  start_date: string;
  recurrence: "weekly" | "biweekly" | "monthly";
  end_date: string;
  notes: string;
  status: ContractRequestStatus;
}

const EMPTY: FormState = {
  recipe_id: "", partner_id: "", alloc_type: "keg",
  packaging_item_id: "", packaging_qty: "", volume_bbl: "",
  cadence: "one_time", delivery_date: "", start_date: "",
  recurrence: "weekly", end_date: "", notes: "", status: "open",
};

const STATUS_META: Record<ContractRequestStatus, { label: string; cls: string }> = {
  open:        { label: "Open",        cls: "bg-amber-900/50 text-amber-400 border-amber-800" },
  in_progress: { label: "In Progress", cls: "bg-blue-900/50 text-blue-400 border-blue-800" },
  fulfilled:   { label: "Fulfilled",   cls: "bg-green-900/50 text-green-400 border-green-800" },
  cancelled:   { label: "Cancelled",   cls: "bg-red-900/40 text-red-400 border-red-800" },
};

function StatusBadge({ status }: { status: ContractRequestStatus }) {
  const m = STATUS_META[status] ?? STATUS_META.open;
  return <span className={`text-xs px-1.5 py-0.5 rounded border font-medium ${m.cls}`}>{m.label}</span>;
}

function AllocationModal({
  recipes, partners, existing, onClose, onDone,
}: {
  recipes: Recipe[];
  partners: ContractBrewingPartner[];
  existing?: Commitment;
  onClose: () => void;
  onDone: () => void;
}) {
  const isEdit = !!existing;
  const { data: packaging = [] } = usePackagingQuery();
  const [form, setForm] = useState<FormState>(existing ? {
    recipe_id: existing.recipe_id ?? "",
    partner_id: existing.partner_id ?? "",
    alloc_type: existing.packaging_items?.volume_fl_oz
      ? (existing.packaging_items.name?.toLowerCase().includes("can") ? "can" : "keg")
      : "bbl",
    packaging_item_id: existing.packaging_item_id ?? "",
    packaging_qty: existing.packaging_qty != null ? String(existing.packaging_qty) : "",
    volume_bbl: String(existing.volume_bbl),
    cadence: existing.cadence,
    delivery_date: existing.desired_delivery_date ?? "",
    start_date: existing.start_date ?? "",
    recurrence: existing.recurrence ?? "weekly",
    end_date: existing.end_date ?? "",
    notes: existing.notes ?? "",
    status: existing.status,
  } : EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  const kegs = packaging.filter((p) => p.type === "keg");
  const cans = packaging.filter((p) => p.type === "can");
  const subItems = form.alloc_type === "keg" ? kegs : form.alloc_type === "can" ? cans : [];
  const selectedItem = packaging.find((p) => p.id === form.packaging_item_id) ?? null;
  const qty = parseFloat(form.packaging_qty) || 0;
  const bblEquiv = selectedItem?.volume_fl_oz && qty > 0
    ? (qty * selectedItem.volume_fl_oz) / FL_OZ_PER_BBL
    : null;

  // Auto-compute volume_bbl when packaging qty changes
  function handleQtyChange(v: string) {
    set("packaging_qty", v);
    const q = parseFloat(v) || 0;
    if (selectedItem?.volume_fl_oz && q > 0) {
      const bbl = (q * selectedItem.volume_fl_oz) / FL_OZ_PER_BBL;
      set("volume_bbl", bbl.toFixed(2));
    }
  }

  function handleItemChange(id: string) {
    set("packaging_item_id", id);
    const item = packaging.find((p) => p.id === id);
    const q = parseFloat(form.packaging_qty) || 0;
    if (item?.volume_fl_oz && q > 0) {
      const bbl = (q * item.volume_fl_oz) / FL_OZ_PER_BBL;
      set("volume_bbl", bbl.toFixed(2));
    }
  }

  function setAllocType(t: AllocType) {
    setForm((f) => ({ ...f, alloc_type: t, packaging_item_id: "" }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.recipe_id) { alert("Please select a recipe."); return; }
    const vol = parseFloat(form.volume_bbl);
    if (!vol || vol <= 0) { alert("Please enter a volume."); return; }
    setSubmitting(true);
    try {
      const beer_style = recipes.find((r) => r.id === form.recipe_id)?.beer_name ?? "";
      const isRecurring = form.cadence === "recurring";
      const body = {
        channel: "distribution",
        recipe_id: form.recipe_id,
        beer_style,
        partner_id: form.partner_id || null,
        volume_bbl: vol,
        packaging_item_id: form.packaging_item_id || null,
        packaging_qty: form.packaging_qty ? parseFloat(form.packaging_qty) : null,
        cadence: form.cadence,
        desired_delivery_date: !isRecurring ? (form.delivery_date || null) : null,
        start_date: isRecurring ? (form.start_date || null) : null,
        recurrence: isRecurring ? form.recurrence : null,
        end_date: isRecurring ? (form.end_date || null) : null,
        status: form.status,
        notes: form.notes || null,
      };
      const url = isEdit
        ? `/api/production/contract-requests?id=${existing!.id}`
        : "/api/production/contract-requests";
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
    <Modal title={isEdit ? "Edit Allocation" : "New Distribution Allocation"} onClose={onClose} wide>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="Beer Style" required>
          <select className="inp" value={form.recipe_id}
            onChange={(e) => set("recipe_id", e.target.value)} required>
            <option value="">— select a recipe —</option>
            {recipes.map((r) => <option key={r.id} value={r.id}>{r.beer_name}</option>)}
          </select>
        </Field>

        <Field label="Partner / Distributor">
          <select className="inp" value={form.partner_id}
            onChange={(e) => set("partner_id", e.target.value)}>
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
          {form.alloc_type === "bbl" ? (
            <Field label="Volume (BBL)" required>
              <input type="number" step="0.01" min="0" className="inp" required
                value={form.volume_bbl} onChange={(e) => set("volume_bbl", e.target.value)} />
            </Field>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <Field label={form.alloc_type === "keg" ? "Keg Size" : "Can Size"} required>
                <select className="inp" value={form.packaging_item_id}
                  onChange={(e) => handleItemChange(e.target.value)} required>
                  <option value="">— select —</option>
                  {subItems.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}{p.volume_fl_oz ? ` (${p.volume_fl_oz} fl oz)` : ""}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={`Qty (${form.alloc_type}s)`} required>
                <input type="number" step="1" min="0" className="inp" required
                  value={form.packaging_qty} onChange={(e) => handleQtyChange(e.target.value)} />
              </Field>
              {bblEquiv != null && bblEquiv > 0 && (
                <Field label="≈ BBL (auto)">
                  <div className="inp text-zinc-400 bg-zinc-900">{bblEquiv.toFixed(2)}</div>
                </Field>
              )}
            </div>
          )}
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
            <select className="inp" value={form.status}
              onChange={(e) => set("status", e.target.value as ContractRequestStatus)}>
              {(["open", "in_progress", "fulfilled", "cancelled"] as ContractRequestStatus[]).map((s) => (
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
    queryKey: queryKeys.production.contractRequestsByType("distribution"),
    queryFn: () => fetchJson<Commitment[]>("/api/production/contract-requests?channel=distribution"),
  });
  const load = () => qc.invalidateQueries({ queryKey: queryKeys.production.contractRequests() });
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Commitment | null>(null);

  async function handleDelete(id: string) {
    if (!confirm("Delete this allocation?")) return;
    const r = await fetch(`/api/production/contract-requests?id=${id}`, { method: "DELETE" });
    if (r.ok) load();
  }

  function pkgLabel(a: Commitment): string {
    if (!a.packaging_item_id || !a.packaging_items) {
      return `${Number(a.volume_bbl).toFixed(2)} BBL`;
    }
    const qty = a.packaging_qty != null ? `${a.packaging_qty} × ` : "";
    return `${qty}${a.packaging_items.name}`;
  }

  function scheduleLabel(a: Commitment): string {
    if (a.cadence === "recurring") {
      const freq = a.recurrence ?? "—";
      const from = a.start_date ? fmtDateLong(a.start_date) : "—";
      const to = a.end_date ? ` → ${fmtDateLong(a.end_date)}` : "";
      return `${freq.charAt(0).toUpperCase() + freq.slice(1)} from ${from}${to}`;
    }
    return a.desired_delivery_date ? fmtDateLong(a.desired_delivery_date) : "—";
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <p className="text-sm text-zinc-500">
          Committed distribution allocations by style and packaging. All are outflows from cold storage.
        </p>
        <button
          onClick={() => setShowModal(true)}
          className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white text-sm font-medium rounded transition-colors"
        >
          + New Allocation
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="text-zinc-600 text-sm py-10 text-center">No distribution allocations recorded yet.</p>
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
                  <td className="px-4 py-2.5 text-zinc-100 font-medium">{a.recipes?.beer_name ?? a.beer_style}</td>
                  <td className="px-4 py-2.5 text-zinc-400">{a.contract_brewing_partners?.company_name ?? "—"}</td>
                  <td className="px-4 py-2.5 text-zinc-300 tabular-nums">{pkgLabel(a)}</td>
                  <td className="px-4 py-2.5 text-zinc-400 text-xs whitespace-nowrap">{scheduleLabel(a)}</td>
                  <td className="px-4 py-2.5"><StatusBadge status={a.status} /></td>
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
