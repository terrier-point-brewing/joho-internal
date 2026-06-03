"use client";

import React, { useEffect, useState, useCallback } from "react";
import { Recipe, ContractBrewingPartner, ContractBrewingRequest } from "../../types";
import { fmtDateLong } from "@/lib/utils/formatting";
import { Modal, Field, ModalActions } from "../shared";

const EMPTY = {
  recipe_id: "",
  beer_style: "",
  partner_id: "",
  volume_bbl: "",
  desired_delivery_date: "",
  notes: "",
};

function NewRequestModal({
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

  // Selecting a recipe auto-fills the style label (still editable / free-text).
  function pickRecipe(id: string) {
    const r = recipes.find((x) => x.id === id);
    setForm((f) => ({ ...f, recipe_id: id, beer_style: r ? r.beer_name : f.beer_style }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await fetch("/api/production/contract-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipe_id: form.recipe_id || null,
          beer_style: form.beer_style,
          partner_id: form.partner_id || null,
          volume_bbl: parseFloat(form.volume_bbl),
          desired_delivery_date: form.desired_delivery_date || null,
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
    <Modal title="New Request" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="Recipe">
          <select className="inp" value={form.recipe_id} onChange={(e) => pickRecipe(e.target.value)}>
            <option value="">— none / custom —</option>
            {recipes.map((r) => <option key={r.id} value={r.id}>{r.beer_name}</option>)}
          </select>
        </Field>
        <Field label="Beer Style" required>
          <input className="inp" required value={form.beer_style} onChange={(e) => set("beer_style", e.target.value)} />
        </Field>
        <Field label="Requestor (Partner)">
          <select className="inp" value={form.partner_id} onChange={(e) => set("partner_id", e.target.value)}>
            <option value="">— none —</option>
            {partners.map((p) => <option key={p.id} value={p.id}>{p.company_name}</option>)}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Volume (BBL)" required>
            <input type="number" step="0.01" min="0" className="inp" required value={form.volume_bbl} onChange={(e) => set("volume_bbl", e.target.value)} />
          </Field>
          <Field label="Desired Delivery">
            <input type="date" className="inp" value={form.desired_delivery_date} onChange={(e) => set("desired_delivery_date", e.target.value)} />
          </Field>
        </div>
        <Field label="Notes">
          <input className="inp" value={form.notes} onChange={(e) => set("notes", e.target.value)} />
        </Field>
        <ModalActions submitting={submitting} onCancel={onClose} label="Create Request" />
      </form>
    </Modal>
  );
}

export default function ContractBrewingTab({
  recipes, partners,
}: {
  recipes: Recipe[];
  partners: ContractBrewingPartner[];
}) {
  const [rows, setRows] = useState<ContractBrewingRequest[]>([]);
  const [showModal, setShowModal] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/production/contract-requests");
    if (r.ok) setRows(await r.json());
  }, []);
  useEffect(() => { load(); }, [load]);

  async function handleDelete(id: string) {
    if (!confirm("Delete this request?")) return;
    const r = await fetch(`/api/production/contract-requests?id=${id}`, { method: "DELETE" });
    if (r.ok) load();
  }

  const COLS = ["Style", "Requestor", "Volume (BBL)", "Desired Delivery", "Status", "Notes", ""];

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <p className="text-sm text-zinc-500">Contract brewing requests from partners.</p>
        <button onClick={() => setShowModal(true)} className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white text-sm font-medium rounded transition-colors">+ New Request</button>
      </div>
      {rows.length === 0 ? (
        <p className="text-zinc-600 text-sm py-10 text-center">No requests recorded yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 bg-zinc-900/50 text-left">
                {COLS.map((h, i) => <th key={i} className="px-4 py-2.5 text-xs font-medium text-zinc-500">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((q, i) => (
                <tr key={q.id} className={`border-b border-zinc-800/60 ${i % 2 !== 0 ? "bg-zinc-900/30" : ""}`}>
                  <td className="px-4 py-2.5 text-zinc-100 font-medium">{q.beer_style}</td>
                  <td className="px-4 py-2.5 text-zinc-400">{q.contract_brewing_partners?.company_name ?? "—"}</td>
                  <td className="px-4 py-2.5 text-zinc-300 tabular-nums">{Number(q.volume_bbl)}</td>
                  <td className="px-4 py-2.5 text-zinc-400 text-xs">{q.desired_delivery_date ? fmtDateLong(q.desired_delivery_date) : "—"}</td>
                  <td className="px-4 py-2.5 text-zinc-400 capitalize">{q.status}</td>
                  <td className="px-4 py-2.5 text-zinc-500 text-xs max-w-[160px] truncate">{q.notes ?? "—"}</td>
                  <td className="px-4 py-2.5">
                    <button onClick={() => handleDelete(q.id)} className="text-xs text-red-400/80 hover:text-red-400">Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {showModal && <NewRequestModal recipes={recipes} partners={partners} onClose={() => setShowModal(false)} onDone={load} />}
    </div>
  );
}
