"use client";

import { useEffect, useState, useCallback } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

type BatchStatus = "fermenting" | "conditioning" | "ready" | "packaged" | "archived";

interface Recipe {
  id: string;
  beer_name: string;
  style: string | null;
  target_volume_bbl: number | null;
  notes: string | null;
  recipe_ingredients: RecipeIngredientRow[];
}

interface Ingredient {
  id: string;
  name: string;
  supplier: string | null;
  unit: string;
  cost_per_unit: number | null;
  stock_quantity: number;
}

interface RecipeIngredientRow {
  id: string;
  recipe_id: string;
  ingredient_id: string;
  quantity_per_bbl: number;
  ingredients: Ingredient;
}

interface BrewBatch {
  id: string;
  beer_name: string;
  batch_number: string | null;
  brew_date: string;
  volume_bbl: number;
  turns: number;
  status: BatchStatus;
  notes: string | null;
  recipe_id: string | null;
  recipes: { beer_name: string; style: string | null } | null;
  created_at: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const BREWHOUSE_BBL = 20;

const STATUS_STYLES: Record<BatchStatus, string> = {
  fermenting: "bg-blue-900/50 text-blue-300 border border-blue-700",
  conditioning: "bg-purple-900/50 text-purple-300 border border-purple-700",
  ready: "bg-green-900/50 text-green-300 border border-green-700",
  packaged: "bg-zinc-700/50 text-zinc-300 border border-zinc-600",
  archived: "bg-zinc-800/50 text-zinc-500 border border-zinc-700",
};

const STATUSES: BatchStatus[] = ["fermenting", "conditioning", "ready", "packaged", "archived"];

const TABS = ["Batch Log", "Ingredients", "Recipes"] as const;
type Tab = typeof TABS[number];

// ─── Root page ────────────────────────────────────────────────────────────────

export default function ProductionPage() {
  const [tab, setTab] = useState<Tab>("Batch Log");
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [batches, setBatches] = useState<BrewBatch[]>([]);

  const loadIngredients = useCallback(async () => {
    const res = await fetch("/api/production/ingredients");
    if (res.ok) setIngredients(await res.json());
  }, []);

  const loadRecipes = useCallback(async () => {
    const res = await fetch("/api/production/recipes");
    if (res.ok) setRecipes(await res.json());
  }, []);

  const loadBatches = useCallback(async () => {
    const res = await fetch("/api/production/batches");
    if (res.ok) setBatches(await res.json());
  }, []);

  useEffect(() => {
    loadIngredients();
    loadRecipes();
    loadBatches();
  }, [loadIngredients, loadRecipes, loadBatches]);

  return (
    <main className="max-w-7xl mx-auto px-6 py-8">
      {/* Subtab nav */}
      <div className="flex gap-1 mb-6 border-b border-zinc-800">
        {TABS.map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              tab === t
                ? "border-amber-500 text-zinc-100"
                : "border-transparent text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "Batch Log" && (
        <BatchLogTab
          batches={batches}
          recipes={recipes}
          onRefresh={loadBatches}
        />
      )}
      {tab === "Ingredients" && (
        <IngredientsTab ingredients={ingredients} onRefresh={loadIngredients} />
      )}
      {tab === "Recipes" && (
        <RecipesTab recipes={recipes} ingredients={ingredients} onRefresh={loadRecipes} />
      )}

      <style>{`
        .inp {
          width: 100%;
          background: rgb(39 39 42);
          border: 1px solid rgb(63 63 70);
          border-radius: 0.375rem;
          padding: 0.375rem 0.5rem;
          font-size: 0.875rem;
          color: rgb(244 244 245);
          outline: none;
        }
        .inp:focus { border-color: rgb(161 161 170); }
        .inp option { background: rgb(39 39 42); }
      `}</style>
    </main>
  );
}

// ─── Batch Log tab ────────────────────────────────────────────────────────────

const BATCH_EMPTY = {
  beer_name: "",
  batch_number: "",
  brew_date: new Date().toISOString().slice(0, 10),
  volume_bbl: "",
  turns: "1",
  status: "fermenting" as BatchStatus,
  notes: "",
  recipe_id: "",
};

function BatchLogTab({
  batches,
  recipes,
  onRefresh,
}: {
  batches: BrewBatch[];
  recipes: Recipe[];
  onRefresh: () => Promise<void>;
}) {
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState(BATCH_EMPTY);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function computeTurns(bbl: string) {
    const v = parseFloat(bbl);
    if (!isNaN(v) && v > 0) return String(Math.ceil(v / BREWHOUSE_BBL));
    return "1";
  }

  function openNew() {
    setForm(BATCH_EMPTY);
    setEditingId(null);
    setShowModal(true);
  }

  function openFromRecipe(r: Recipe) {
    setForm({
      ...BATCH_EMPTY,
      beer_name: r.beer_name,
      volume_bbl: r.target_volume_bbl ? String(r.target_volume_bbl) : "",
      turns: r.target_volume_bbl ? computeTurns(String(r.target_volume_bbl)) : "1",
      recipe_id: r.id,
    });
    setEditingId(null);
    setShowModal(true);
  }

  function openEdit(b: BrewBatch) {
    setForm({
      beer_name: b.beer_name,
      batch_number: b.batch_number ?? "",
      brew_date: b.brew_date,
      volume_bbl: String(b.volume_bbl),
      turns: String(b.turns),
      status: b.status,
      notes: b.notes ?? "",
      recipe_id: b.recipe_id ?? "",
    });
    setEditingId(b.id);
    setShowModal(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const payload = {
        beer_name: form.beer_name,
        batch_number: form.batch_number || null,
        brew_date: form.brew_date,
        volume_bbl: parseFloat(form.volume_bbl),
        turns: parseInt(form.turns),
        status: form.status,
        notes: form.notes || null,
        recipe_id: form.recipe_id || null,
      };
      const res = editingId
        ? await fetch(`/api/production/batches/${editingId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch("/api/production/batches", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
      if (!res.ok) throw new Error(await res.text());
      setShowModal(false);
      await onRefresh();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Error saving batch");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id: string, name: string) {
    if (!confirm(`Delete batch "${name}"?`)) return;
    await fetch(`/api/production/batches/${id}`, { method: "DELETE" });
    await onRefresh();
  }

  async function updateStatus(id: string, status: BatchStatus) {
    await fetch(`/api/production/batches/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    await onRefresh();
  }

  const active = batches.filter(b => b.status !== "archived");
  const archived = batches.filter(b => b.status === "archived");

  return (
    <>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-medium text-zinc-100">Brew Batch Log</h2>
          <p className="text-sm text-zinc-500 mt-0.5">Track active and historical brew batches · {BREWHOUSE_BBL} BBL brewhouse</p>
        </div>
        <button onClick={openNew} className="btn-amber">+ New Batch</button>
      </div>

      {active.length === 0 && archived.length === 0 ? (
        <p className="text-zinc-600 text-sm">No batches yet. Add your first batch or start from a recipe.</p>
      ) : (
        <>
          <BatchTable
            batches={active}
            onEdit={openEdit}
            onDelete={handleDelete}
            onStatusChange={updateStatus}
          />
          {archived.length > 0 && (
            <details className="mt-8">
              <summary className="text-sm text-zinc-500 cursor-pointer hover:text-zinc-400 select-none mb-3">
                Archived ({archived.length})
              </summary>
              <BatchTable
                batches={archived}
                onEdit={openEdit}
                onDelete={handleDelete}
                onStatusChange={updateStatus}
              />
            </details>
          )}
        </>
      )}

      {/* Quick-brew from recipe */}
      {recipes.length > 0 && (
        <div className="mt-8">
          <p className="text-xs text-zinc-500 mb-2">Start batch from recipe:</p>
          <div className="flex flex-wrap gap-2">
            {recipes.map(r => (
              <button
                key={r.id}
                onClick={() => openFromRecipe(r)}
                className="px-3 py-1 text-xs bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded text-zinc-300 transition-colors"
              >
                {r.beer_name}
              </button>
            ))}
          </div>
        </div>
      )}

      {showModal && (
        <Modal title={editingId ? "Edit Batch" : "New Batch"} onClose={() => setShowModal(false)}>
          <form onSubmit={handleSubmit} className="space-y-4">
            <Field label="Beer Name" required>
              <input className="inp" value={form.beer_name} required
                onChange={e => setForm(f => ({ ...f, beer_name: e.target.value }))} />
            </Field>
            <Field label="Recipe (optional)">
              <select className="inp" value={form.recipe_id}
                onChange={e => {
                  const r = recipes.find(r => r.id === e.target.value);
                  setForm(f => ({
                    ...f,
                    recipe_id: e.target.value,
                    ...(r ? { beer_name: r.beer_name } : {}),
                    ...(r?.target_volume_bbl ? {
                      volume_bbl: String(r.target_volume_bbl),
                      turns: computeTurns(String(r.target_volume_bbl)),
                    } : {}),
                  }));
                }}>
                <option value="">— none —</option>
                {recipes.map(r => <option key={r.id} value={r.id}>{r.beer_name}{r.style ? ` (${r.style})` : ""}</option>)}
              </select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Batch #">
                <input className="inp" placeholder="e.g. 001" value={form.batch_number}
                  onChange={e => setForm(f => ({ ...f, batch_number: e.target.value }))} />
              </Field>
              <Field label="Brew Date" required>
                <input type="date" className="inp" value={form.brew_date} required
                  onChange={e => setForm(f => ({ ...f, brew_date: e.target.value }))} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Volume (BBL)" required>
                <input type="number" step="0.01" min="0" className="inp" value={form.volume_bbl} required
                  onChange={e => setForm(f => ({
                    ...f,
                    volume_bbl: e.target.value,
                    turns: computeTurns(e.target.value),
                  }))} />
              </Field>
              <Field label={`Turns (${BREWHOUSE_BBL} BBL brewhouse)`} required>
                <input type="number" min="1" step="1" className="inp" value={form.turns} required
                  onChange={e => setForm(f => ({ ...f, turns: e.target.value }))} />
              </Field>
            </div>
            <Field label="Status" required>
              <select className="inp" value={form.status}
                onChange={e => setForm(f => ({ ...f, status: e.target.value as BatchStatus }))}>
                {STATUSES.map(s => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
              </select>
            </Field>
            <Field label="Notes">
              <textarea className="inp resize-none" rows={2} value={form.notes}
                onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
            </Field>
            <ModalActions submitting={submitting} onCancel={() => setShowModal(false)}
              label={editingId ? "Save Changes" : "Create Batch"} />
          </form>
        </Modal>
      )}
    </>
  );
}

function BatchTable({
  batches, onEdit, onDelete, onStatusChange,
}: {
  batches: BrewBatch[];
  onEdit: (b: BrewBatch) => void;
  onDelete: (id: string, name: string) => void;
  onStatusChange: (id: string, s: BatchStatus) => void;
}) {
  if (!batches.length) return null;
  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-800">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-800 text-left">
            {["Beer", "Batch #", "Brew Date", "Volume", "Turns", "Status", "Notes", ""].map(h => (
              <th key={h} className={`px-4 py-2.5 text-xs font-medium text-zinc-500 ${h === "Volume" || h === "Turns" ? "text-right" : ""}`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {batches.map((b, i) => (
            <tr key={b.id} className={`border-b border-zinc-800/60 ${i % 2 !== 0 ? "bg-zinc-900/30" : ""}`}>
              <td className="px-4 py-2.5 text-zinc-100 font-medium">
                {b.beer_name}
                {b.recipes && <span className="ml-1.5 text-xs text-zinc-500">({b.recipes.style ?? "recipe"})</span>}
              </td>
              <td className="px-4 py-2.5 text-zinc-400">{b.batch_number ?? "—"}</td>
              <td className="px-4 py-2.5 text-zinc-400">{b.brew_date}</td>
              <td className="px-4 py-2.5 text-zinc-300 text-right">{Number(b.volume_bbl).toFixed(1)} BBL</td>
              <td className="px-4 py-2.5 text-zinc-400 text-right">{b.turns}</td>
              <td className="px-4 py-2.5">
                <select
                  value={b.status}
                  onChange={e => onStatusChange(b.id, e.target.value as BatchStatus)}
                  className={`text-xs px-2 py-0.5 rounded font-medium cursor-pointer border-0 outline-none appearance-none ${STATUS_STYLES[b.status]}`}
                  style={{ background: "transparent" }}
                >
                  {STATUSES.map(s => (
                    <option key={s} value={s} style={{ background: "rgb(39 39 42)", color: "rgb(244 244 245)" }}>
                      {s.charAt(0).toUpperCase() + s.slice(1)}
                    </option>
                  ))}
                </select>
              </td>
              <td className="px-4 py-2.5 text-zinc-500 max-w-[180px] truncate">{b.notes ?? "—"}</td>
              <td className="px-4 py-2.5">
                <div className="flex gap-3 justify-end">
                  <button onClick={() => onEdit(b)} className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors">Edit</button>
                  <button onClick={() => onDelete(b.id, b.beer_name)} className="text-xs text-zinc-600 hover:text-red-400 transition-colors">Delete</button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Ingredients tab ──────────────────────────────────────────────────────────

const ING_EMPTY = { name: "", supplier: "", unit: "", cost_per_unit: "", stock_quantity: "0" };

function IngredientsTab({ ingredients, onRefresh }: { ingredients: Ingredient[]; onRefresh: () => Promise<void> }) {
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState(ING_EMPTY);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [stockEdit, setStockEdit] = useState<{ id: string; value: string } | null>(null);

  function openNew() { setForm(ING_EMPTY); setEditingId(null); setShowModal(true); }
  function openEdit(ing: Ingredient) {
    setForm({
      name: ing.name,
      supplier: ing.supplier ?? "",
      unit: ing.unit,
      cost_per_unit: ing.cost_per_unit != null ? String(ing.cost_per_unit) : "",
      stock_quantity: String(ing.stock_quantity),
    });
    setEditingId(ing.id);
    setShowModal(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const payload = {
        name: form.name,
        supplier: form.supplier || null,
        unit: form.unit,
        cost_per_unit: form.cost_per_unit !== "" ? parseFloat(form.cost_per_unit) : null,
        stock_quantity: parseFloat(form.stock_quantity) || 0,
      };
      const res = editingId
        ? await fetch(`/api/production/ingredients/${editingId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch("/api/production/ingredients", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
      if (!res.ok) throw new Error(await res.text());
      setShowModal(false);
      await onRefresh();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Error");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id: string, name: string) {
    if (!confirm(`Delete ingredient "${name}"?`)) return;
    await fetch(`/api/production/ingredients/${id}`, { method: "DELETE" });
    await onRefresh();
  }

  async function saveStock(id: string) {
    if (!stockEdit) return;
    await fetch(`/api/production/ingredients/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stock_quantity: parseFloat(stockEdit.value) || 0 }),
    });
    setStockEdit(null);
    await onRefresh();
  }

  return (
    <>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-medium text-zinc-100">Ingredients</h2>
          <p className="text-sm text-zinc-500 mt-0.5">Manage ingredient inventory and costs</p>
        </div>
        <button onClick={openNew} className="btn-amber">+ New Ingredient</button>
      </div>

      {ingredients.length === 0 ? (
        <p className="text-zinc-600 text-sm">No ingredients yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-left">
                {["Name", "Supplier", "Unit", "Cost / Unit", "Stock", ""].map(h => (
                  <th key={h} className={`px-4 py-2.5 text-xs font-medium text-zinc-500 ${h === "Cost / Unit" || h === "Stock" ? "text-right" : ""}`}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ingredients.map((ing, i) => (
                <tr key={ing.id} className={`border-b border-zinc-800/60 ${i % 2 !== 0 ? "bg-zinc-900/30" : ""}`}>
                  <td className="px-4 py-2.5 text-zinc-100 font-medium">{ing.name}</td>
                  <td className="px-4 py-2.5 text-zinc-400">{ing.supplier ?? "—"}</td>
                  <td className="px-4 py-2.5 text-zinc-400">{ing.unit}</td>
                  <td className="px-4 py-2.5 text-zinc-300 text-right">
                    {ing.cost_per_unit != null ? `$${Number(ing.cost_per_unit).toFixed(4)}` : "—"}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {stockEdit?.id === ing.id ? (
                      <div className="flex items-center gap-1 justify-end">
                        <input
                          type="number"
                          step="0.001"
                          className="inp w-24 text-right"
                          value={stockEdit.value}
                          onChange={e => setStockEdit({ id: ing.id, value: e.target.value })}
                          autoFocus
                        />
                        <button onClick={() => saveStock(ing.id)} className="text-xs text-green-400 hover:text-green-300">Save</button>
                        <button onClick={() => setStockEdit(null)} className="text-xs text-zinc-500 hover:text-zinc-300">×</button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setStockEdit({ id: ing.id, value: String(ing.stock_quantity) })}
                        className="text-zinc-300 hover:text-zinc-100 transition-colors tabular-nums"
                        title="Click to edit stock"
                      >
                        {Number(ing.stock_quantity).toLocaleString(undefined, { maximumFractionDigits: 3 })} {ing.unit}
                      </button>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex gap-3 justify-end">
                      <button onClick={() => openEdit(ing)} className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors">Edit</button>
                      <button onClick={() => handleDelete(ing.id, ing.name)} className="text-xs text-zinc-600 hover:text-red-400 transition-colors">Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showModal && (
        <Modal title={editingId ? "Edit Ingredient" : "New Ingredient"} onClose={() => setShowModal(false)}>
          <form onSubmit={handleSubmit} className="space-y-4">
            <Field label="Name" required>
              <input className="inp" value={form.name} required onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
            </Field>
            <Field label="Supplier">
              <input className="inp" placeholder="e.g. BSG, Yakima Chief" value={form.supplier}
                onChange={e => setForm(f => ({ ...f, supplier: e.target.value }))} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Unit" required>
                <input className="inp" placeholder="e.g. lb, oz, each" value={form.unit} required
                  onChange={e => setForm(f => ({ ...f, unit: e.target.value }))} />
              </Field>
              <Field label="Cost per Unit ($)">
                <input type="number" step="0.0001" min="0" className="inp" placeholder="0.0000"
                  value={form.cost_per_unit} onChange={e => setForm(f => ({ ...f, cost_per_unit: e.target.value }))} />
              </Field>
            </div>
            <Field label="Stock Quantity">
              <input type="number" step="0.001" min="0" className="inp" value={form.stock_quantity}
                onChange={e => setForm(f => ({ ...f, stock_quantity: e.target.value }))} />
            </Field>
            <ModalActions submitting={submitting} onCancel={() => setShowModal(false)}
              label={editingId ? "Save Changes" : "Add Ingredient"} />
          </form>
        </Modal>
      )}
    </>
  );
}

// ─── Recipes tab ──────────────────────────────────────────────────────────────

interface RecipeFormLine {
  ingredient_id: string;
  quantity_per_bbl: string;
}

const RECIPE_EMPTY = { beer_name: "", style: "", target_volume_bbl: "", notes: "" };

function RecipesTab({
  recipes,
  ingredients,
  onRefresh,
}: {
  recipes: Recipe[];
  ingredients: Ingredient[];
  onRefresh: () => Promise<void>;
}) {
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState(RECIPE_EMPTY);
  const [lines, setLines] = useState<RecipeFormLine[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  function openNew() {
    setForm(RECIPE_EMPTY);
    setLines([]);
    setEditingId(null);
    setShowModal(true);
  }

  function openEdit(r: Recipe) {
    setForm({
      beer_name: r.beer_name,
      style: r.style ?? "",
      target_volume_bbl: r.target_volume_bbl != null ? String(r.target_volume_bbl) : "",
      notes: r.notes ?? "",
    });
    setLines(r.recipe_ingredients.map(ri => ({
      ingredient_id: ri.ingredient_id,
      quantity_per_bbl: String(ri.quantity_per_bbl),
    })));
    setEditingId(r.id);
    setShowModal(true);
  }

  function addLine() {
    setLines(l => [...l, { ingredient_id: ingredients[0]?.id ?? "", quantity_per_bbl: "" }]);
  }

  function removeLine(i: number) {
    setLines(l => l.filter((_, idx) => idx !== i));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const payload = {
        beer_name: form.beer_name,
        style: form.style || null,
        target_volume_bbl: form.target_volume_bbl ? parseFloat(form.target_volume_bbl) : null,
        notes: form.notes || null,
        ingredients: lines
          .filter(l => l.ingredient_id && l.quantity_per_bbl)
          .map(l => ({ ingredient_id: l.ingredient_id, quantity_per_bbl: parseFloat(l.quantity_per_bbl) })),
      };
      const res = editingId
        ? await fetch(`/api/production/recipes/${editingId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch("/api/production/recipes", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
      if (!res.ok) throw new Error(await res.text());
      setShowModal(false);
      await onRefresh();
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Error");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id: string, name: string) {
    if (!confirm(`Delete recipe "${name}"?`)) return;
    await fetch(`/api/production/recipes/${id}`, { method: "DELETE" });
    await onRefresh();
  }

  function recipeCost(r: Recipe, targetBbl?: number | null): number {
    const bbl = targetBbl ?? r.target_volume_bbl ?? 1;
    return r.recipe_ingredients.reduce((sum, ri) => {
      const cost = ri.ingredients.cost_per_unit ?? 0;
      return sum + ri.quantity_per_bbl * bbl * cost;
    }, 0);
  }

  return (
    <>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-medium text-zinc-100">Recipes</h2>
          <p className="text-sm text-zinc-500 mt-0.5">Define beer recipes with ingredient bills</p>
        </div>
        <button onClick={openNew} className="btn-amber">+ New Recipe</button>
      </div>

      {recipes.length === 0 ? (
        <p className="text-zinc-600 text-sm">No recipes yet.</p>
      ) : (
        <div className="space-y-3">
          {recipes.map(r => {
            const cost = recipeCost(r);
            const isOpen = expanded === r.id;
            return (
              <div key={r.id} className="rounded-lg border border-zinc-800 overflow-hidden">
                <div
                  className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-zinc-900/40 transition-colors"
                  onClick={() => setExpanded(isOpen ? null : r.id)}
                >
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-medium text-zinc-100">{r.beer_name}</span>
                    {r.style && <span className="text-xs text-zinc-500 bg-zinc-800 px-2 py-0.5 rounded">{r.style}</span>}
                    {r.target_volume_bbl && <span className="text-xs text-zinc-500">{r.target_volume_bbl} BBL target</span>}
                  </div>
                  <div className="flex items-center gap-4">
                    {cost > 0 && (
                      <span className="text-xs text-zinc-400">
                        ${cost.toFixed(2)} total · ${r.target_volume_bbl ? (cost / r.target_volume_bbl).toFixed(2) : "—"}/BBL
                      </span>
                    )}
                    <span className="text-xs text-zinc-500">{r.recipe_ingredients.length} ingredients</span>
                    <span className="text-zinc-600 text-xs">{isOpen ? "▲" : "▼"}</span>
                  </div>
                </div>

                {isOpen && (
                  <div className="border-t border-zinc-800 px-4 py-3">
                    {r.recipe_ingredients.length > 0 ? (
                      <table className="w-full text-sm mb-3">
                        <thead>
                          <tr className="text-left border-b border-zinc-800">
                            <th className="pb-2 text-xs font-medium text-zinc-500">Ingredient</th>
                            <th className="pb-2 text-xs font-medium text-zinc-500 text-right">Qty / BBL</th>
                            <th className="pb-2 text-xs font-medium text-zinc-500 text-right">Cost / BBL</th>
                            {r.target_volume_bbl && <th className="pb-2 text-xs font-medium text-zinc-500 text-right">Total ({r.target_volume_bbl} BBL)</th>}
                          </tr>
                        </thead>
                        <tbody>
                          {r.recipe_ingredients.map(ri => {
                            const ing = ri.ingredients;
                            const costPerBbl = ri.quantity_per_bbl * (ing.cost_per_unit ?? 0);
                            const total = costPerBbl * (r.target_volume_bbl ?? 1);
                            return (
                              <tr key={ri.id} className="border-b border-zinc-800/40">
                                <td className="py-1.5 text-zinc-200">{ing.name}</td>
                                <td className="py-1.5 text-zinc-400 text-right tabular-nums">
                                  {Number(ri.quantity_per_bbl).toLocaleString(undefined, { maximumFractionDigits: 4 })} {ing.unit}
                                </td>
                                <td className="py-1.5 text-zinc-400 text-right tabular-nums">
                                  {ing.cost_per_unit != null ? `$${costPerBbl.toFixed(4)}` : "—"}
                                </td>
                                {r.target_volume_bbl && (
                                  <td className="py-1.5 text-zinc-300 text-right tabular-nums">
                                    {ing.cost_per_unit != null ? `$${total.toFixed(2)}` : "—"}
                                  </td>
                                )}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    ) : (
                      <p className="text-xs text-zinc-600 mb-3">No ingredients on this recipe.</p>
                    )}
                    {r.notes && <p className="text-xs text-zinc-500 mb-3 italic">{r.notes}</p>}
                    <div className="flex gap-3">
                      <button onClick={() => openEdit(r)} className="text-xs text-zinc-400 hover:text-zinc-200 transition-colors">Edit recipe</button>
                      <button onClick={() => handleDelete(r.id, r.beer_name)} className="text-xs text-zinc-600 hover:text-red-400 transition-colors">Delete</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {showModal && (
        <Modal title={editingId ? "Edit Recipe" : "New Recipe"} onClose={() => setShowModal(false)} wide>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Beer Name" required>
                <input className="inp" value={form.beer_name} required
                  onChange={e => setForm(f => ({ ...f, beer_name: e.target.value }))} />
              </Field>
              <Field label="Style">
                <input className="inp" placeholder="e.g. IPA, Stout" value={form.style}
                  onChange={e => setForm(f => ({ ...f, style: e.target.value }))} />
              </Field>
            </div>
            <Field label="Target Volume (BBL)">
              <input type="number" step="0.01" min="0" className="inp" placeholder="20"
                value={form.target_volume_bbl} onChange={e => setForm(f => ({ ...f, target_volume_bbl: e.target.value }))} />
            </Field>

            {/* Ingredient bill */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs text-zinc-400">Ingredient Bill <span className="text-zinc-600">(qty per BBL)</span></label>
                <button type="button" onClick={addLine} className="text-xs text-amber-500 hover:text-amber-400 transition-colors">+ Add ingredient</button>
              </div>
              {ingredients.length === 0 && (
                <p className="text-xs text-zinc-600">Add ingredients in the Ingredients tab first.</p>
              )}
              {lines.map((line, i) => {
                const ing = ingredients.find(ing => ing.id === line.ingredient_id);
                const costPerBbl = ing?.cost_per_unit != null && line.quantity_per_bbl
                  ? ing.cost_per_unit * parseFloat(line.quantity_per_bbl)
                  : null;
                return (
                  <div key={i} className="flex items-center gap-2 mb-2">
                    <select className="inp flex-1" value={line.ingredient_id}
                      onChange={e => setLines(ls => ls.map((l, idx) => idx === i ? { ...l, ingredient_id: e.target.value } : l))}>
                      {ingredients.map(ing => <option key={ing.id} value={ing.id}>{ing.name} ({ing.unit})</option>)}
                    </select>
                    <input type="number" step="0.0001" min="0" placeholder="qty/BBL"
                      className="inp w-28" value={line.quantity_per_bbl}
                      onChange={e => setLines(ls => ls.map((l, idx) => idx === i ? { ...l, quantity_per_bbl: e.target.value } : l))} />
                    {costPerBbl != null && (
                      <span className="text-xs text-zinc-500 w-20 text-right tabular-nums">${costPerBbl.toFixed(4)}/BBL</span>
                    )}
                    <button type="button" onClick={() => removeLine(i)} className="text-zinc-600 hover:text-red-400 text-sm transition-colors">×</button>
                  </div>
                );
              })}
            </div>

            <Field label="Notes">
              <textarea className="inp resize-none" rows={2} value={form.notes}
                onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
            </Field>
            <ModalActions submitting={submitting} onCancel={() => setShowModal(false)}
              label={editingId ? "Save Changes" : "Create Recipe"} />
          </form>
        </Modal>
      )}
    </>
  );
}

// ─── Shared UI components ─────────────────────────────────────────────────────

function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className={`bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl w-full ${wide ? "max-w-2xl" : "max-w-md"} max-h-[90vh] overflow-y-auto`}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800 sticky top-0 bg-zinc-900">
          <h3 className="text-sm font-medium text-zinc-100">{title}</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 text-lg leading-none">×</button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs text-zinc-400 mb-1">
        {label}{required && <span className="text-red-400 ml-0.5">*</span>}
      </label>
      {children}
    </div>
  );
}

function ModalActions({ submitting, onCancel, label }: { submitting: boolean; onCancel: () => void; label: string }) {
  return (
    <div className="flex justify-end gap-2 pt-1">
      <button type="button" onClick={onCancel} className="px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-200 transition-colors">Cancel</button>
      <button type="submit" disabled={submitting}
        className="px-4 py-1.5 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-sm font-medium rounded transition-colors">
        {submitting ? "Saving…" : label}
      </button>
    </div>
  );
}
