"use client";

import { useState } from "react";
import { Recipe, Ingredient, leadTimeDays } from "../types";
import { Modal, Field, ModalActions } from "./shared";

interface RecipeFormLine {
  ingredient_id: string;
  quantity_per_bbl: string;
}

const RECIPE_EMPTY = { beer_name: "", brewery: "", expected_yield_bbl: "", days_brewhouse: "", days_fermenter: "", days_brite: "", steps: "", notes: "" };

export default function RecipesTab({
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
      brewery: r.brewery ?? "",
      expected_yield_bbl: r.expected_yield_bbl != null ? String(r.expected_yield_bbl) : "",
      days_brewhouse: r.days_brewhouse != null ? String(r.days_brewhouse) : "",
      days_fermenter: r.days_fermenter != null ? String(r.days_fermenter) : "",
      days_brite: r.days_brite != null ? String(r.days_brite) : "",
      steps: r.steps ?? "",
      notes: r.notes ?? "",
    });
    setLines(
      r.recipe_ingredients.map((ri) => ({
        ingredient_id: ri.ingredient_id,
        quantity_per_bbl: String(ri.quantity_per_bbl),
      }))
    );
    setEditingId(r.id);
    setShowModal(true);
  }

  function addLine() {
    if (!ingredients.length) return;
    setLines((l) => [...l, { ingredient_id: ingredients[0].id, quantity_per_bbl: "" }]);
  }

  function removeLine(i: number) {
    setLines((l) => l.filter((_, idx) => idx !== i));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const payload = {
        beer_name: form.beer_name,
        brewery: form.brewery || null,
        expected_yield_bbl: form.expected_yield_bbl ? parseFloat(form.expected_yield_bbl) : null,
        days_brewhouse: form.days_brewhouse ? parseInt(form.days_brewhouse) : null,
        days_fermenter: form.days_fermenter ? parseInt(form.days_fermenter) : null,
        days_brite: form.days_brite ? parseInt(form.days_brite) : null,
        steps: form.steps || null,
        notes: form.notes || null,
        ingredients: lines
          .filter((l) => l.ingredient_id && l.quantity_per_bbl)
          .map((l) => ({ ingredient_id: l.ingredient_id, quantity_per_bbl: parseFloat(l.quantity_per_bbl) })),
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
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
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

  function recipeTotalCost(r: Recipe): number {
    const bbl = r.expected_yield_bbl ?? 1;
    return r.recipe_ingredients.reduce((sum, ri) => {
      return sum + ri.quantity_per_bbl * bbl * (ri.ingredients.cost_per_unit ?? 0);
    }, 0);
  }

  return (
    <>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-base font-medium text-zinc-100">Recipes</h2>
          <p className="text-sm text-zinc-500 mt-0.5">Define beer recipes with ingredient bills and brew steps</p>
        </div>
        <button onClick={openNew} className="btn-amber">+ New Recipe</button>
      </div>

      {recipes.length === 0 ? (
        <p className="text-zinc-600 text-sm">No recipes yet.</p>
      ) : (
        <div className="space-y-2">
          {recipes.map((r) => {
            const isOpen = expanded === r.id;
            const totalCost = recipeTotalCost(r);
            const costPerBbl = r.expected_yield_bbl ? totalCost / r.expected_yield_bbl : null;

            return (
              <div key={r.id} className="rounded-lg border border-zinc-800 overflow-hidden">
                {/* Header row */}
                <div
                  className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-zinc-900/40 transition-colors"
                  onClick={() => setExpanded(isOpen ? null : r.id)}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="text-sm font-medium text-zinc-100 truncate">{r.beer_name}</span>
                    {r.brewery && (
                      <span className="text-xs text-zinc-500 bg-zinc-800 px-2 py-0.5 rounded shrink-0">
                        {r.brewery}
                      </span>
                    )}
                    {r.expected_yield_bbl && (
                      <span className="text-xs text-zinc-500 shrink-0">
                        {r.expected_yield_bbl} BBL / turn
                      </span>
                    )}
                    {leadTimeDays(r) > 0 && (
                      <span className="text-xs text-zinc-500 shrink-0">
                        {leadTimeDays(r)}d lead time
                      </span>
                    )}
                    {(r.days_brewhouse || r.days_fermenter || r.days_brite) && (
                      <span className="text-xs text-zinc-600 shrink-0">
                        {[r.days_brewhouse && `BH ${r.days_brewhouse}d`, r.days_fermenter && `FV ${r.days_fermenter}d`, r.days_brite && `BT ${r.days_brite}d`].filter(Boolean).join(" · ")}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-4 shrink-0 ml-4">
                    {totalCost > 0 && (
                      <div className="text-right">
                        <span className="text-xs text-zinc-400">
                          ${totalCost.toFixed(2)} total
                        </span>
                        {costPerBbl != null && (
                          <span className="text-xs text-zinc-600 ml-2">
                            ${costPerBbl.toFixed(2)}/BBL
                          </span>
                        )}
                      </div>
                    )}
                    <span className="text-xs text-zinc-600">
                      {r.recipe_ingredients.length} ingredient{r.recipe_ingredients.length !== 1 ? "s" : ""}
                    </span>
                    <span className="text-zinc-600 text-xs w-3">{isOpen ? "▲" : "▼"}</span>
                  </div>
                </div>

                {/* Expanded detail */}
                {isOpen && (
                  <div className="border-t border-zinc-800">
                    {/* Ingredient bill table */}
                    {r.recipe_ingredients.length > 0 ? (
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-zinc-800 bg-zinc-900/50 text-left">
                            <th className="px-4 py-2 text-xs font-medium text-zinc-500">Ingredient</th>
                            <th className="px-4 py-2 text-xs font-medium text-zinc-500 text-right">Qty / BBL</th>
                            <th className="px-4 py-2 text-xs font-medium text-zinc-500 text-right">Cost / BBL</th>
                            {r.expected_yield_bbl && (
                              <th className="px-4 py-2 text-xs font-medium text-zinc-500 text-right">
                                Total ({r.expected_yield_bbl} BBL)
                              </th>
                            )}
                          </tr>
                        </thead>
                        <tbody>
                          {r.recipe_ingredients.map((ri, idx) => {
                            const ing = ri.ingredients;
                            const costPerBblLine = ri.quantity_per_bbl * (ing.cost_per_unit ?? 0);
                            const totalLine = costPerBblLine * (r.expected_yield_bbl ?? 1);
                            return (
                              <tr
                                key={ri.id}
                                className={`border-b border-zinc-800/40 ${idx % 2 !== 0 ? "bg-zinc-900/20" : ""}`}
                              >
                                <td className="px-4 py-2 text-zinc-200">{ing.name}</td>
                                <td className="px-4 py-2 text-zinc-400 text-right tabular-nums">
                                  {Number(ri.quantity_per_bbl).toLocaleString(undefined, { maximumFractionDigits: 4 })}{" "}
                                  {ing.unit}
                                </td>
                                <td className="px-4 py-2 text-zinc-400 text-right tabular-nums">
                                  {ing.cost_per_unit != null ? `$${costPerBblLine.toFixed(2)}` : "—"}
                                </td>
                                {r.expected_yield_bbl && (
                                  <td className="px-4 py-2 text-zinc-300 text-right tabular-nums">
                                    {ing.cost_per_unit != null ? `$${totalLine.toFixed(2)}` : "—"}
                                  </td>
                                )}
                              </tr>
                            );
                          })}
                          {/* Totals row */}
                          {r.expected_yield_bbl && totalCost > 0 && (
                            <tr className="border-t border-zinc-700 bg-zinc-900/50">
                              <td className="px-4 py-2 text-xs font-medium text-zinc-400" colSpan={3}>Total ingredient cost</td>
                              <td className="px-4 py-2 text-right text-zinc-200 font-medium tabular-nums">
                                ${totalCost.toFixed(2)}
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    ) : (
                      <p className="text-xs text-zinc-600 px-4 py-3">No ingredients on this recipe.</p>
                    )}

                    {/* Stage durations */}
                    {(r.days_brewhouse || r.days_fermenter || r.days_brite) && (
                      <div className="px-4 py-3 border-t border-zinc-800">
                        <p className="text-xs font-medium text-zinc-500 mb-2">Stage Duration</p>
                        <div className="flex gap-6">
                          {[
                            { label: "Brewhouse", val: r.days_brewhouse },
                            { label: "Fermenter", val: r.days_fermenter },
                            { label: "Brite Tank", val: r.days_brite },
                          ].map(({ label, val }) => (
                            <div key={label}>
                              <p className="text-xs text-zinc-600">{label}</p>
                              <p className="text-sm text-zinc-300">{val != null ? `${val} days` : "—"}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Steps */}
                    {r.steps && (
                      <div className="px-4 py-3 border-t border-zinc-800">
                        <p className="text-xs font-medium text-zinc-500 mb-1.5">Brew Steps</p>
                        <pre className="text-xs text-zinc-400 whitespace-pre-wrap font-sans leading-relaxed">
                          {r.steps}
                        </pre>
                      </div>
                    )}

                    {/* Notes */}
                    {r.notes && (
                      <div className="px-4 pb-3 border-t border-zinc-800 pt-3">
                        <p className="text-xs text-zinc-500 italic">{r.notes}</p>
                      </div>
                    )}

                    {/* Actions */}
                    <div className="flex gap-3 px-4 py-2.5 border-t border-zinc-800 bg-zinc-900/30">
                      <button
                        onClick={() => openEdit(r)}
                        className="text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
                      >
                        Edit recipe
                      </button>
                      <button
                        onClick={() => handleDelete(r.id, r.beer_name)}
                        className="text-xs text-zinc-600 hover:text-red-400 transition-colors"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {showModal && (
        <Modal
          title={editingId ? "Edit Recipe" : "New Recipe"}
          onClose={() => setShowModal(false)}
          wide
        >
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Beer Name" required>
                <input className="inp" value={form.beer_name} required
                  onChange={(e) => setForm((f) => ({ ...f, beer_name: e.target.value }))} />
              </Field>
              <Field label="Brewery" hint="(contract brewing partner)">
                <input className="inp" placeholder="e.g. Fortnight Brewing" value={form.brewery}
                  onChange={(e) => setForm((f) => ({ ...f, brewery: e.target.value }))} />
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Expected Yield / Turn (BBL)" hint={`for a ${20} BBL brewhouse`}>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  className="inp"
                  placeholder="e.g. 18.5"
                  value={form.expected_yield_bbl}
                  onChange={(e) => setForm((f) => ({ ...f, expected_yield_bbl: e.target.value }))}
                />
              </Field>
              <Field label="Lead Time" hint="(sum of stage days)">
                <div className="inp flex items-center text-zinc-300 tabular-nums">
                  {(parseInt(form.days_brewhouse) || 0) + (parseInt(form.days_fermenter) || 0) + (parseInt(form.days_brite) || 0)} days
                </div>
              </Field>
            </div>

            <div>
              <p className="text-xs text-zinc-400 mb-2">Stage Duration (days)</p>
              <div className="grid grid-cols-3 gap-3">
                <Field label="Brewhouse">
                  <input type="number" step="1" min="0" className="inp" placeholder="e.g. 1"
                    value={form.days_brewhouse}
                    onChange={(e) => setForm((f) => ({ ...f, days_brewhouse: e.target.value }))} />
                </Field>
                <Field label="Fermenter">
                  <input type="number" step="1" min="0" className="inp" placeholder="e.g. 14"
                    value={form.days_fermenter}
                    onChange={(e) => setForm((f) => ({ ...f, days_fermenter: e.target.value }))} />
                </Field>
                <Field label="Brite Tank">
                  <input type="number" step="1" min="0" className="inp" placeholder="e.g. 7"
                    value={form.days_brite}
                    onChange={(e) => setForm((f) => ({ ...f, days_brite: e.target.value }))} />
                </Field>
              </div>
            </div>

            {/* Ingredient bill */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs text-zinc-400">
                  Ingredient Bill <span className="text-zinc-600">(qty per BBL)</span>
                </label>
                {ingredients.length > 0 && (
                  <button
                    type="button"
                    onClick={addLine}
                    className="text-xs text-amber-500 hover:text-amber-400 transition-colors"
                  >
                    + Add ingredient
                  </button>
                )}
              </div>
              {ingredients.length === 0 && (
                <p className="text-xs text-zinc-600">Add ingredients in the Ingredients tab first.</p>
              )}
              {lines.length > 0 && (
                <div className="rounded border border-zinc-800 overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-zinc-800 bg-zinc-900/50">
                        <th className="px-3 py-2 text-xs font-medium text-zinc-500 text-left">Ingredient</th>
                        <th className="px-3 py-2 text-xs font-medium text-zinc-500 text-right">Qty / BBL</th>
                        <th className="px-3 py-2 text-xs font-medium text-zinc-500 text-right">$/BBL</th>
                        <th className="px-3 py-2 w-6"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {lines.map((line, i) => {
                        const ing = ingredients.find((ing) => ing.id === line.ingredient_id);
                        const costPerBbl =
                          ing?.cost_per_unit != null && line.quantity_per_bbl
                            ? ing.cost_per_unit * parseFloat(line.quantity_per_bbl)
                            : null;
                        return (
                          <tr key={i} className={`border-b border-zinc-800/60 ${i % 2 !== 0 ? "bg-zinc-900/20" : ""}`}>
                            <td className="px-3 py-1.5">
                              <select
                                className="inp"
                                value={line.ingredient_id}
                                onChange={(e) =>
                                  setLines((ls) =>
                                    ls.map((l, idx) =>
                                      idx === i ? { ...l, ingredient_id: e.target.value } : l
                                    )
                                  )
                                }
                              >
                                {ingredients.map((ing) => (
                                  <option key={ing.id} value={ing.id}>
                                    {ing.name} ({ing.unit})
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td className="px-3 py-1.5">
                              <input
                                type="number"
                                step="0.0001"
                                min="0"
                                placeholder="qty/BBL"
                                className="inp text-right"
                                value={line.quantity_per_bbl}
                                onChange={(e) =>
                                  setLines((ls) =>
                                    ls.map((l, idx) =>
                                      idx === i ? { ...l, quantity_per_bbl: e.target.value } : l
                                    )
                                  )
                                }
                              />
                            </td>
                            <td className="px-3 py-1.5 text-right text-xs text-zinc-500 tabular-nums whitespace-nowrap">
                              {costPerBbl != null ? `$${costPerBbl.toFixed(2)}` : "—"}
                            </td>
                            <td className="px-3 py-1.5 text-center">
                              <button
                                type="button"
                                onClick={() => removeLine(i)}
                                className="text-zinc-600 hover:text-red-400 transition-colors"
                              >
                                ×
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <Field label="Brew Steps">
              <textarea
                className="inp resize-none font-mono text-xs"
                rows={6}
                placeholder={"1. Mash at 152°F for 60 min\n2. Sparge to collect 26 gal\n3. Boil 60 min…"}
                value={form.steps}
                onChange={(e) => setForm((f) => ({ ...f, steps: e.target.value }))}
              />
            </Field>

            <Field label="Notes">
              <textarea
                className="inp resize-none"
                rows={2}
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              />
            </Field>

            <ModalActions
              submitting={submitting}
              onCancel={() => setShowModal(false)}
              label={editingId ? "Save Changes" : "Create Recipe"}
            />
          </form>
        </Modal>
      )}
    </>
  );
}
