"use client";

import React, { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Recipe, ContractBrewingPartner, ContractBrewingRequest } from "../../types";
import { fmtDateLong } from "@/lib/utils/formatting";
import { Modal, Field, ModalActions } from "../shared";
import { fetchJson } from "../../hooks/queries";

interface QuickRecipe {
  beer_name: string;
  brewery: string;
  expected_yield_bbl: string;
  days_brewhouse: string;
  days_fermenter: string;
  days_brite: string;
}

const RECIPE_EMPTY: QuickRecipe = {
  beer_name: "", brewery: "", expected_yield_bbl: "",
  days_brewhouse: "", days_fermenter: "", days_brite: "",
};

function QuickNewRecipeModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (recipe: Recipe) => void;
}) {
  const [form, setForm] = useState<QuickRecipe>(RECIPE_EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const set = (k: keyof QuickRecipe, v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await fetch("/api/production/recipes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          beer_name: form.beer_name,
          brewery: form.brewery || null,
          expected_yield_bbl: form.expected_yield_bbl ? parseFloat(form.expected_yield_bbl) : null,
          days_brewhouse: form.days_brewhouse ? parseInt(form.days_brewhouse) : null,
          days_fermenter: form.days_fermenter ? parseInt(form.days_fermenter) : null,
          days_brite: form.days_brite ? parseInt(form.days_brite) : null,
          ingredients: [],
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      const created: Recipe = await res.json();
      onCreated(created);
      onClose();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Quick New Recipe" onClose={onClose}>
      <p className="text-xs text-zinc-500 mb-4">Creates a recipe with core fields. Add ingredients and steps later in the Recipes tab.</p>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="Beer Name" required>
          <input className="inp" required value={form.beer_name} onChange={(e) => set("beer_name", e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Brewery" hint="(contract partner)">
            <input className="inp" value={form.brewery} onChange={(e) => set("brewery", e.target.value)} />
          </Field>
          <Field label="Yield / Turn (BBL)">
            <input type="number" step="0.01" min="0" className="inp" value={form.expected_yield_bbl}
              onChange={(e) => set("expected_yield_bbl", e.target.value)} />
          </Field>
        </div>
        <div>
          <p className="text-xs text-zinc-400 mb-2">Stage Duration (days)</p>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Brewhouse">
              <input type="number" step="1" min="0" className="inp" value={form.days_brewhouse}
                onChange={(e) => set("days_brewhouse", e.target.value)} />
            </Field>
            <Field label="Fermenter">
              <input type="number" step="1" min="0" className="inp" value={form.days_fermenter}
                onChange={(e) => set("days_fermenter", e.target.value)} />
            </Field>
            <Field label="Brite Tank">
              <input type="number" step="1" min="0" className="inp" value={form.days_brite}
                onChange={(e) => set("days_brite", e.target.value)} />
            </Field>
          </div>
        </div>
        <ModalActions submitting={submitting} onCancel={onClose} label="Create Recipe" />
      </form>
    </Modal>
  );
}

const EMPTY = {
  recipe_id: "",
  partner_id: "",
  volume_bbl: "",
  desired_delivery_date: "",
  notes: "",
};

function NewRequestModal({
  recipes: initialRecipes, partners, onClose, onDone,
}: {
  recipes: Recipe[];
  partners: ContractBrewingPartner[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [form, setForm] = useState(EMPTY);
  const [recipes, setRecipes] = useState<Recipe[]>(initialRecipes);
  const [showNewRecipe, setShowNewRecipe] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const set = (k: keyof typeof EMPTY, v: string) => setForm((f) => ({ ...f, [k]: v }));

  function onRecipeCreated(r: Recipe) {
    setRecipes((prev) => [...prev, r]);
    setForm((f) => ({ ...f, recipe_id: r.id }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.recipe_id) { alert("Please select a recipe."); return; }
    setSubmitting(true);
    try {
      const beer_style = recipes.find((r) => r.id === form.recipe_id)?.beer_name ?? "";
      const res = await fetch("/api/production/contract-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipe_id: form.recipe_id,
          beer_style,
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
    <>
      <Modal title="New Request" onClose={onClose}>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Field label="Recipe" required>
            <div className="flex gap-2">
              <select className="inp flex-1" value={form.recipe_id}
                onChange={(e) => set("recipe_id", e.target.value)} required>
                <option value="">— select a recipe —</option>
                {recipes.map((r) => <option key={r.id} value={r.id}>{r.beer_name}</option>)}
              </select>
              <button type="button" onClick={() => setShowNewRecipe(true)}
                className="px-3 py-1.5 border border-zinc-700 hover:border-zinc-500 text-zinc-300 text-xs rounded transition-colors whitespace-nowrap">
                + New Recipe
              </button>
            </div>
          </Field>
          <Field label="Requestor (Partner)">
            <select className="inp" value={form.partner_id} onChange={(e) => set("partner_id", e.target.value)}>
              <option value="">— none —</option>
              {partners.map((p) => <option key={p.id} value={p.id}>{p.company_name}</option>)}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Volume (BBL)" required>
              <input type="number" step="0.01" min="0" className="inp" required
                value={form.volume_bbl} onChange={(e) => set("volume_bbl", e.target.value)} />
            </Field>
            <Field label="Desired Delivery">
              <input type="date" className="inp" value={form.desired_delivery_date}
                onChange={(e) => set("desired_delivery_date", e.target.value)} />
            </Field>
          </div>
          <Field label="Notes">
            <input className="inp" value={form.notes} onChange={(e) => set("notes", e.target.value)} />
          </Field>
          <ModalActions submitting={submitting} onCancel={onClose} label="Create Request" />
        </form>
      </Modal>
      {showNewRecipe && (
        <QuickNewRecipeModal onClose={() => setShowNewRecipe(false)} onCreated={onRecipeCreated} />
      )}
    </>
  );
}

export default function ContractBrewingTab({
  recipes, partners,
}: {
  recipes: Recipe[];
  partners: ContractBrewingPartner[];
}) {
  const qc = useQueryClient();
  const { data: rows = [] } = useQuery({
    queryKey: ["production", "contract-requests"],
    queryFn: () => fetchJson<ContractBrewingRequest[]>("/api/production/contract-requests"),
  });
  const load = () => qc.invalidateQueries({ queryKey: ["production", "contract-requests"] });
  const [showModal, setShowModal] = useState(false);

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
