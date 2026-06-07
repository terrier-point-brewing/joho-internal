"use client";

import React, { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Recipe, ContractBrewingPartner, ContractBrewingRequest, ContractRequestStatus } from "../../types";
import { fmtDateLong } from "@/lib/utils/formatting";
import { Modal, Field, ModalActions } from "../shared";
import { fetchJson, usePackagingQuery } from "../../hooks/queries";

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

interface QuickRecipe {
  beer_name: string; brewery: string; expected_yield_bbl: string;
  days_brewhouse: string; days_fermenter: string; days_brite: string;
}

const RECIPE_EMPTY: QuickRecipe = { beer_name: "", brewery: "", expected_yield_bbl: "", days_brewhouse: "", days_fermenter: "", days_brite: "" };

function QuickNewRecipeModal({ onClose, onCreated }: { onClose: () => void; onCreated: (r: Recipe) => void }) {
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
          beer_name: form.beer_name, brewery: form.brewery || null,
          expected_yield_bbl: form.expected_yield_bbl ? parseFloat(form.expected_yield_bbl) : null,
          days_brewhouse: form.days_brewhouse ? parseInt(form.days_brewhouse) : null,
          days_fermenter: form.days_fermenter ? parseInt(form.days_fermenter) : null,
          days_brite: form.days_brite ? parseInt(form.days_brite) : null,
          ingredients: [],
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      onCreated(await res.json());
      onClose();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Error");
    } finally { setSubmitting(false); }
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
            <Field label="Brewhouse"><input type="number" step="1" min="0" className="inp" value={form.days_brewhouse} onChange={(e) => set("days_brewhouse", e.target.value)} /></Field>
            <Field label="Fermenter"><input type="number" step="1" min="0" className="inp" value={form.days_fermenter} onChange={(e) => set("days_fermenter", e.target.value)} /></Field>
            <Field label="Brite Tank"><input type="number" step="1" min="0" className="inp" value={form.days_brite} onChange={(e) => set("days_brite", e.target.value)} /></Field>
          </div>
        </div>
        <ModalActions submitting={submitting} onCancel={onClose} label="Create Recipe" />
      </form>
    </Modal>
  );
}

interface FormState {
  recipe_id: string; partner_id: string; volume_bbl: string;
  desired_delivery_date: string; status: ContractRequestStatus; notes: string;
  packaging_item_id: string; packaging_qty: string;
}
const FORM_EMPTY: FormState = {
  recipe_id: "", partner_id: "", volume_bbl: "", desired_delivery_date: "",
  status: "open", notes: "", packaging_item_id: "", packaging_qty: "",
};

function RequestModal({
  recipes: initialRecipes, partners, existing, onClose, onDone,
}: {
  recipes: Recipe[];
  partners: ContractBrewingPartner[];
  existing?: ContractBrewingRequest;
  onClose: () => void;
  onDone: () => void;
}) {
  const isEdit = !!existing;
  const { data: packaging = [] } = usePackagingQuery();
  const [recipes, setRecipes] = useState<Recipe[]>(initialRecipes);
  const [showNewRecipe, setShowNewRecipe] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState<FormState>(existing ? {
    recipe_id: existing.recipe_id ?? "",
    partner_id: existing.partner_id ?? "",
    volume_bbl: String(existing.volume_bbl),
    desired_delivery_date: existing.desired_delivery_date ?? "",
    status: existing.status,
    notes: existing.notes ?? "",
    packaging_item_id: existing.packaging_item_id ?? "",
    packaging_qty: existing.packaging_qty != null ? String(existing.packaging_qty) : "",
  } : FORM_EMPTY);
  const set = (k: keyof FormState, v: string) => setForm((f) => ({ ...f, [k]: v }));

  function onRecipeCreated(r: Recipe) {
    setRecipes((prev) => [...prev, r]);
    set("recipe_id", r.id);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.recipe_id) { alert("Please select a recipe."); return; }
    setSubmitting(true);
    try {
      const beer_style = recipes.find((r) => r.id === form.recipe_id)?.beer_name ?? "";
      const body = {
        recipe_id: form.recipe_id,
        beer_style,
        partner_id: form.partner_id || null,
        volume_bbl: parseFloat(form.volume_bbl),
        desired_delivery_date: form.desired_delivery_date || null,
        status: form.status,
        notes: form.notes || null,
        packaging_item_id: form.packaging_item_id || null,
        packaging_qty: form.packaging_qty ? parseFloat(form.packaging_qty) : null,
      };
      const url = isEdit ? `/api/production/contract-requests?id=${existing!.id}` : "/api/production/contract-requests";
      const res = await fetch(url, { method: isEdit ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      onDone(); onClose();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Error");
    } finally { setSubmitting(false); }
  }

  const kegs = packaging.filter((p) => p.type === "keg");
  const cans = packaging.filter((p) => p.type === "can");
  const allPkg = [...kegs, ...cans];

  return (
    <>
      <Modal title={isEdit ? "Edit Request" : "New Contract Request"} onClose={onClose} wide>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Field label="Recipe" required>
            <div className="flex gap-2">
              <select className="inp flex-1" value={form.recipe_id}
                onChange={(e) => set("recipe_id", e.target.value)} required>
                <option value="">— select a recipe —</option>
                {recipes.map((r) => <option key={r.id} value={r.id}>{r.beer_name}</option>)}
              </select>
              {!isEdit && (
                <button type="button" onClick={() => setShowNewRecipe(true)}
                  className="px-3 py-1.5 border border-zinc-700 hover:border-zinc-500 text-zinc-300 text-xs rounded transition-colors whitespace-nowrap">
                  + New Recipe
                </button>
              )}
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

          {/* Packaging preference */}
          <div className="rounded border border-zinc-800 px-3 py-3 space-y-3">
            <p className="text-xs font-medium text-zinc-400">Packaging Preference</p>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Container type">
                <select className="inp" value={form.packaging_item_id} onChange={(e) => set("packaging_item_id", e.target.value)}>
                  <option value="">— not specified —</option>
                  {kegs.length > 0 && (
                    <optgroup label="Kegs">
                      {kegs.map((p) => <option key={p.id} value={p.id}>{p.name}{p.volume_fl_oz ? ` (${p.volume_fl_oz} fl oz)` : ""}</option>)}
                    </optgroup>
                  )}
                  {cans.length > 0 && (
                    <optgroup label="Cans">
                      {cans.map((p) => <option key={p.id} value={p.id}>{p.name}{p.volume_fl_oz ? ` (${p.volume_fl_oz} fl oz)` : ""}</option>)}
                    </optgroup>
                  )}
                </select>
              </Field>
              <Field label="Quantity">
                <input type="number" step="1" min="0" className="inp" placeholder="# of containers"
                  value={form.packaging_qty} onChange={(e) => set("packaging_qty", e.target.value)} />
              </Field>
            </div>
            {allPkg.length === 0 && (
              <p className="text-xs text-zinc-600">No packaging items configured. Add them in Inventory → Packaging.</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Status">
              <select className="inp" value={form.status} onChange={(e) => set("status", e.target.value as ContractRequestStatus)}>
                {(["open", "in_progress", "fulfilled", "cancelled"] as ContractRequestStatus[]).map((s) => (
                  <option key={s} value={s}>{STATUS_META[s].label}</option>
                ))}
              </select>
            </Field>
            <Field label="Notes">
              <input className="inp" value={form.notes} onChange={(e) => set("notes", e.target.value)} />
            </Field>
          </div>

          <ModalActions submitting={submitting} onCancel={onClose} label={isEdit ? "Save Changes" : "Create Request"} />
        </form>
      </Modal>
      {showNewRecipe && (
        <QuickNewRecipeModal onClose={() => setShowNewRecipe(false)} onCreated={onRecipeCreated} />
      )}
    </>
  );
}

export default function ContractBrewingTab({ recipes, partners }: { recipes: Recipe[]; partners: ContractBrewingPartner[] }) {
  const qc = useQueryClient();
  const { data: rows = [] } = useQuery({
    queryKey: ["production", "contract-requests"],
    queryFn: () => fetchJson<ContractBrewingRequest[]>("/api/production/contract-requests"),
  });
  const load = () => qc.invalidateQueries({ queryKey: ["production", "contract-requests"] });
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<ContractBrewingRequest | null>(null);

  async function handleDelete(id: string) {
    if (!confirm("Delete this request?")) return;
    const r = await fetch(`/api/production/contract-requests?id=${id}`, { method: "DELETE" });
    if (r.ok) load();
  }

  function pkgLabel(q: ContractBrewingRequest): string {
    if (!q.packaging_item_id) return "—";
    const item = q.packaging_items;
    if (!item) return "—";
    const qty = q.packaging_qty != null ? `${q.packaging_qty} × ` : "";
    return `${qty}${item.name}`;
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <p className="text-sm text-zinc-500">Contract brewing requests from partners. All fulfilled via cold storage export.</p>
        <button onClick={() => setShowModal(true)} className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white text-sm font-medium rounded transition-colors">+ New Request</button>
      </div>
      {rows.length === 0 ? (
        <p className="text-zinc-600 text-sm py-10 text-center">No requests recorded yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 bg-zinc-900/50 text-left">
                {["Style", "Requestor", "Volume", "Packaging Pref.", "Delivery", "Status", "Notes", ""].map((h, i) => (
                  <th key={i} className="px-4 py-2.5 text-xs font-medium text-zinc-500">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((q, i) => (
                <tr key={q.id} className={`border-b border-zinc-800/60 ${i % 2 !== 0 ? "bg-zinc-900/30" : ""}`}>
                  <td className="px-4 py-2.5 text-zinc-100 font-medium">{q.beer_style}</td>
                  <td className="px-4 py-2.5 text-zinc-400">{q.contract_brewing_partners?.company_name ?? "—"}</td>
                  <td className="px-4 py-2.5 text-zinc-300 tabular-nums">{Number(q.volume_bbl)} BBL</td>
                  <td className="px-4 py-2.5 text-zinc-400 text-xs">{pkgLabel(q)}</td>
                  <td className="px-4 py-2.5 text-zinc-400 text-xs whitespace-nowrap">
                    {q.desired_delivery_date ? fmtDateLong(q.desired_delivery_date) : "—"}
                  </td>
                  <td className="px-4 py-2.5"><StatusBadge status={q.status} /></td>
                  <td className="px-4 py-2.5 text-zinc-500 text-xs max-w-[160px] truncate">{q.notes ?? "—"}</td>
                  <td className="px-4 py-2.5 flex items-center gap-3">
                    <button onClick={() => setEditing(q)} className="text-xs text-zinc-400 hover:text-zinc-200">Edit</button>
                    <button onClick={() => handleDelete(q.id)} className="text-xs text-red-400/80 hover:text-red-400">Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {showModal && <RequestModal recipes={recipes} partners={partners} onClose={() => setShowModal(false)} onDone={load} />}
      {editing && <RequestModal recipes={recipes} partners={partners} existing={editing} onClose={() => setEditing(null)} onDone={load} />}
    </div>
  );
}
