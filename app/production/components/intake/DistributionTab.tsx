"use client";

import React, { useEffect, useState, useCallback } from "react";
import { Recipe, ContractBrewingPartner, DistributionAllocation } from "../../types";
import { fmtDateLong } from "@/lib/utils/formatting";
import { Modal, Field, ModalActions } from "../shared";

const EMPTY = {
  recipe_id: "",
  packaging: "keg",
  quantity: "",
  unit: "keg",
  cadence: "one_time",
  delivery_date: "",
  start_date: "",
  recurrence: "weekly",
  end_date: "",
  partner_id: "",
  notes: "",
};

function NewAllocationModal({
  recipes, partners, onClose, onDone,
}: {
  recipes: Recipe[];
  partners: ContractBrewingPartner[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [form, setForm] = useState(EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const set = (k: keyof typeof EMPTY, v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await fetch("/api/production/distribution-allocations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipe_id: form.recipe_id || null,
          packaging: form.packaging,
          quantity: parseFloat(form.quantity),
          unit: form.unit,
          cadence: form.cadence,
          delivery_date: form.delivery_date || null,
          start_date: form.start_date || null,
          recurrence: form.recurrence,
          end_date: form.end_date || null,
          partner_id: form.partner_id || null,
          notes: form.notes || null,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      onDone();
      onClose();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="New Allocation" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="Beer Style">
          <select className="inp" value={form.recipe_id} onChange={(e) => set("recipe_id", e.target.value)}>
            <option value="">— select a recipe —</option>
            {recipes.map((r) => <option key={r.id} value={r.id}>{r.beer_name}</option>)}
          </select>
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Packaging" required>
            <select className="inp" value={form.packaging} onChange={(e) => set("packaging", e.target.value)}>
              <option value="draft">Draft</option>
              <option value="keg">Keg</option>
              <option value="can">Can</option>
            </select>
          </Field>
          <Field label="Quantity" required>
            <input type="number" step="0.01" min="0" className="inp" required value={form.quantity} onChange={(e) => set("quantity", e.target.value)} />
          </Field>
          <Field label="Unit" required>
            <input className="inp" required value={form.unit} onChange={(e) => set("unit", e.target.value)} placeholder="keg / can / bbl" />
          </Field>
        </div>
        <Field label="Partner">
          <select className="inp" value={form.partner_id} onChange={(e) => set("partner_id", e.target.value)}>
            <option value="">— none —</option>
            {partners.map((p) => <option key={p.id} value={p.id}>{p.company_name}</option>)}
          </select>
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
            <input type="date" className="inp" required value={form.delivery_date} onChange={(e) => set("delivery_date", e.target.value)} />
          </Field>
        ) : (
          <div className="grid grid-cols-3 gap-3">
            <Field label="Start Date" required>
              <input type="date" className="inp" required value={form.start_date} onChange={(e) => set("start_date", e.target.value)} />
            </Field>
            <Field label="Frequency" required>
              <select className="inp" value={form.recurrence} onChange={(e) => set("recurrence", e.target.value)}>
                <option value="weekly">Weekly</option>
                <option value="biweekly">Biweekly</option>
                <option value="monthly">Monthly</option>
              </select>
            </Field>
            <Field label="End Date">
              <input type="date" className="inp" value={form.end_date} onChange={(e) => set("end_date", e.target.value)} />
            </Field>
          </div>
        )}
        <Field label="Notes">
          <input className="inp" value={form.notes} onChange={(e) => set("notes", e.target.value)} />
        </Field>
        <ModalActions submitting={submitting} onCancel={onClose} label="Create Allocation" />
      </form>
    </Modal>
  );
}

export default function DistributionTab({
  recipes, partners,
}: {
  recipes: Recipe[];
  partners: ContractBrewingPartner[];
}) {
  const [rows, setRows] = useState<DistributionAllocation[]>([]);
  const [showModal, setShowModal] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/production/distribution-allocations");
    if (r.ok) setRows(await r.json());
  }, []);
  useEffect(() => { load(); }, [load]);

  async function handleDelete(id: string) {
    if (!confirm("Delete this allocation?")) return;
    const r = await fetch(`/api/production/distribution-allocations?id=${id}`, { method: "DELETE" });
    if (r.ok) load();
  }

  function schedule(a: DistributionAllocation): string {
    if (a.cadence === "one_time") return `One-time · ${a.delivery_date ? fmtDateLong(a.delivery_date) : "—"}`;
    return `${a.recurrence ?? "—"} from ${a.start_date ? fmtDateLong(a.start_date) : "—"}${a.end_date ? ` to ${fmtDateLong(a.end_date)}` : ""}`;
  }

  const COLS = ["Style", "Packaging", "Quantity", "Partner", "Schedule", "Notes", ""];

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <p className="text-sm text-zinc-500">Committed purchase allocations by style and packaging.</p>
        <button onClick={() => setShowModal(true)} className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white text-sm font-medium rounded transition-colors">+ New Allocation</button>
      </div>
      {rows.length === 0 ? (
        <p className="text-zinc-600 text-sm py-10 text-center">No allocations recorded yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 bg-zinc-900/50 text-left">
                {COLS.map((h, i) => <th key={i} className="px-4 py-2.5 text-xs font-medium text-zinc-500">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((a, i) => (
                <tr key={a.id} className={`border-b border-zinc-800/60 ${i % 2 !== 0 ? "bg-zinc-900/30" : ""}`}>
                  <td className="px-4 py-2.5 text-zinc-100 font-medium">{a.recipes?.beer_name ?? "—"}</td>
                  <td className="px-4 py-2.5 text-zinc-400 capitalize">{a.packaging}</td>
                  <td className="px-4 py-2.5 text-zinc-300 tabular-nums">{Number(a.quantity)} {a.unit}</td>
                  <td className="px-4 py-2.5 text-zinc-400">{a.contract_brewing_partners?.company_name ?? "—"}</td>
                  <td className="px-4 py-2.5 text-zinc-400 text-xs">{schedule(a)}</td>
                  <td className="px-4 py-2.5 text-zinc-500 text-xs max-w-[160px] truncate">{a.notes ?? "—"}</td>
                  <td className="px-4 py-2.5">
                    <button onClick={() => handleDelete(a.id)} className="text-xs text-red-400/80 hover:text-red-400">Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {showModal && <NewAllocationModal recipes={recipes} partners={partners} onClose={() => setShowModal(false)} onDone={load} />}
    </div>
  );
}
