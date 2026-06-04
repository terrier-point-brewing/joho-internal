"use client";

import { useState, useEffect, useCallback } from "react";
import { Recipe, Ingredient, ContractBrewingPartner, INGREDIENT_CATEGORIES, IngredientCategory, leadTimeDays } from "../types";
import { Modal, Field, ModalActions } from "./shared";
import { EQ } from "../equipmentMeta";

interface RecipeFormLine {
  ingredient_id: string;
  quantity_per_turn: string;
}

const RECIPE_EMPTY = { beer_name: "", partner_id: "", expected_yield_bbl: "", days_brewhouse: "", days_fermenter: "", days_brite: "", steps: "", notes: "" };

const STAGE_BADGES: Record<"brewhouse" | "fermenter" | "brite", { label: string; badge: string }> = {
  brewhouse: { label: EQ.brewhouse.label, badge: EQ.brewhouse.badge },
  fermenter:  { label: EQ.fermenter.label,  badge: EQ.fermenter.badge },
  brite:      { label: "Brite Tank",        badge: EQ.brite.badge },
};

/** Very lightweight markdown → React-safe HTML string renderer. */
function mdToHtml(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inList = false;
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s: string) =>
    esc(s)
      .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.*?)\*/g, "<em>$1</em>")
      .replace(/`(.*?)`/g, "<code>$1</code>");

  for (const raw of lines) {
    const line = raw.trimEnd();
    const isItem = /^[-*] /.test(line) || /^\d+\. /.test(line);
    if (!isItem && inList) { out.push("</ul>"); inList = false; }
    if (/^### /.test(line)) { out.push(`<h3>${inline(line.slice(4))}</h3>`); }
    else if (/^## /.test(line))  { out.push(`<h2>${inline(line.slice(3))}</h2>`); }
    else if (/^# /.test(line))   { out.push(`<h1>${inline(line.slice(2))}</h1>`); }
    else if (/^[-*] /.test(line)) {
      if (!inList) { out.push("<ul>"); inList = true; }
      out.push(`<li>${inline(line.slice(2))}</li>`);
    } else if (/^\d+\. /.test(line)) {
      const m = line.match(/^\d+\. (.*)/);
      if (!inList) { out.push("<ul>"); inList = true; }
      out.push(`<li>${inline(m![1])}</li>`);
    } else if (line.trim() === "") {
      out.push("<br/>");
    } else {
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  if (inList) out.push("</ul>");
  return out.join("\n");
}

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

  const [partners, setPartners] = useState<ContractBrewingPartner[]>([]);
  const loadPartners = useCallback(async () => {
    const r = await fetch("/api/partners/contract-brewing");
    if (r.ok) setPartners(await r.json());
  }, []);
  useEffect(() => { loadPartners(); }, [loadPartners]);

  // Category filter for ingredient bill picker
  const [ingCatFilter, setIngCatFilter] = useState<IngredientCategory | "all">("all");
  const filteredIngredients = ingCatFilter === "all" ? ingredients : ingredients.filter((i) => i.category === ingCatFilter);

  const yieldBbl = parseFloat(form.expected_yield_bbl) || 1;

  function openNew() {
    setForm(RECIPE_EMPTY);
    setLines([]);
    setEditingId(null);
    setIngCatFilter("all");
    setShowModal(true);
  }

  function openEdit(r: Recipe) {
    const yld = r.expected_yield_bbl ?? 1;
    setForm({
      beer_name: r.beer_name,
      partner_id: r.brewery ?? "",
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
        quantity_per_turn: String(Number((ri.quantity_per_bbl * yld).toFixed(6))),
      }))
    );
    setIngCatFilter("all");
    setEditingId(r.id);
    setShowModal(true);
  }

  function addLine() {
    const firstIng = filteredIngredients[0] ?? ingredients[0];
    if (!firstIng) return;
    setLines((l) => [...l, { ingredient_id: firstIng.id, quantity_per_turn: "" }]);
  }

  function removeLine(i: number) {
    setLines((l) => l.filter((_, idx) => idx !== i));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const partnerObj = partners.find((p) => p.id === form.partner_id);
      const payload = {
        beer_name: form.beer_name,
        brewery: partnerObj?.company_name ?? form.partner_id ?? null,
        expected_yield_bbl: form.expected_yield_bbl ? parseFloat(form.expected_yield_bbl) : null,
        days_brewhouse: form.days_brewhouse ? parseInt(form.days_brewhouse) : null,
        days_fermenter: form.days_fermenter ? parseInt(form.days_fermenter) : null,
        days_brite: form.days_brite ? parseInt(form.days_brite) : null,
        steps: form.steps || null,
        notes: form.notes || null,
        ingredients: lines
          .filter((l) => l.ingredient_id && l.quantity_per_turn)
          .map((l) => ({
            ingredient_id: l.ingredient_id,
            quantity_per_bbl: parseFloat(l.quantity_per_turn) / yieldBbl,
          })),
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
    const res = await fetch(`/api/production/recipes/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      alert(body?.error ?? "Delete failed");
      return;
    }
    await onRefresh();
  }

  function recipeCostPerTurn(r: Recipe): number {
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
            const costPerTurn = recipeCostPerTurn(r);
            const costPerBblYield = r.expected_yield_bbl ? costPerTurn / r.expected_yield_bbl : null;

            return (
              <div key={r.id} className="rounded-lg border border-zinc-800 overflow-hidden">
                {/* Header row */}
                <div
                  className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-zinc-900/40 transition-colors"
                  onClick={() => setExpanded(isOpen ? null : r.id)}
                >
                  <div className="flex items-center gap-3 min-w-0 flex-wrap">
                    <span className="text-sm font-medium text-zinc-100 truncate">{r.beer_name}</span>
                    {r.brewery && (
                      <span className="text-xs text-zinc-500 bg-zinc-800 px-2 py-0.5 rounded shrink-0">
                        {r.brewery}
                      </span>
                    )}
                    {r.expected_yield_bbl && (
                      <span className="text-xs text-zinc-500 shrink-0">
                        {r.expected_yield_bbl.toLocaleString()} BBL Yield / 20 BBL Turn
                      </span>
                    )}
                    {leadTimeDays(r) > 0 && (
                      <span className="text-xs text-zinc-500 shrink-0">
                        {leadTimeDays(r)}d lead time
                      </span>
                    )}
                    {(r.days_brewhouse || r.days_fermenter || r.days_brite) && (
                      <span className="flex items-center gap-1 shrink-0">
                        {r.days_brewhouse != null && (
                          <span className={`text-xs px-1.5 py-px rounded border ${STAGE_BADGES.brewhouse.badge}`}>
                            {STAGE_BADGES.brewhouse.label} {r.days_brewhouse}d
                          </span>
                        )}
                        {r.days_fermenter != null && (
                          <span className={`text-xs px-1.5 py-px rounded border ${STAGE_BADGES.fermenter.badge}`}>
                            {STAGE_BADGES.fermenter.label} {r.days_fermenter}d
                          </span>
                        )}
                        {r.days_brite != null && (
                          <span className={`text-xs px-1.5 py-px rounded border ${STAGE_BADGES.brite.badge}`}>
                            {STAGE_BADGES.brite.label} {r.days_brite}d
                          </span>
                        )}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-4 shrink-0 ml-4">
                    {costPerTurn > 0 && (
                      <div className="text-right">
                        <span className="text-xs text-zinc-400 tabular-nums">
                          ${costPerTurn.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} / turn
                        </span>
                        {costPerBblYield != null && (
                          <span className="text-xs text-zinc-600 ml-2 tabular-nums">
                            ${costPerBblYield.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} / BBL
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
                            <th className="px-4 py-2 text-xs font-medium text-zinc-500 text-right">Cost / Unit</th>
                            <th className="px-4 py-2 text-xs font-medium text-zinc-500 text-right">Qty / Turn</th>
                            <th className="px-4 py-2 text-xs font-medium text-zinc-500 text-right">$ / Turn</th>
                          </tr>
                        </thead>
                        <tbody>
                          {r.recipe_ingredients.map((ri, idx) => {
                            const ing = ri.ingredients;
                            const qtyPerTurn = ri.quantity_per_bbl * (r.expected_yield_bbl ?? 1);
                            const costPerLine = qtyPerTurn * (ing.cost_per_unit ?? 0);
                            return (
                              <tr
                                key={ri.id}
                                className={`border-b border-zinc-800/40 ${idx % 2 !== 0 ? "bg-zinc-900/20" : ""}`}
                              >
                                <td className="px-4 py-2 text-zinc-200">{ing.name}</td>
                                <td className="px-4 py-2 text-zinc-500 text-right tabular-nums">
                                  {ing.cost_per_unit != null
                                    ? `$${Number(ing.cost_per_unit).toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 })} / ${ing.unit}`
                                    : "—"}
                                </td>
                                <td className="px-4 py-2 text-zinc-400 text-right tabular-nums">
                                  {qtyPerTurn.toLocaleString(undefined, { maximumFractionDigits: 4 })} {ing.unit}
                                </td>
                                <td className="px-4 py-2 text-zinc-300 text-right tabular-nums">
                                  {ing.cost_per_unit != null
                                    ? `$${costPerLine.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                                    : "—"}
                                </td>
                              </tr>
                            );
                          })}
                          {/* Totals row */}
                          {costPerTurn > 0 && (
                            <tr className="border-t border-zinc-700 bg-zinc-900/50">
                              <td className="px-4 py-2 text-xs font-medium text-zinc-400" colSpan={3}>Total cost / turn</td>
                              <td className="px-4 py-2 text-right text-zinc-200 font-medium tabular-nums">
                                ${costPerTurn.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                              </td>
                            </tr>
                          )}
                          {costPerBblYield != null && costPerTurn > 0 && (
                            <tr className="bg-zinc-900/30">
                              <td className="px-4 py-2 text-xs font-medium text-zinc-500" colSpan={3}>Cost / BBL yield</td>
                              <td className="px-4 py-2 text-right text-zinc-400 tabular-nums text-xs">
                                ${costPerBblYield.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
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
                        <div className="flex gap-4">
                          {(["brewhouse", "fermenter", "brite"] as const).map((stage) => {
                            const val = stage === "brewhouse" ? r.days_brewhouse : stage === "fermenter" ? r.days_fermenter : r.days_brite;
                            if (val == null) return null;
                            return (
                              <div key={stage} className="flex items-center gap-2">
                                <span className={`text-xs px-1.5 py-px rounded border ${STAGE_BADGES[stage].badge}`}>
                                  {STAGE_BADGES[stage].label}
                                </span>
                                <span className="text-sm text-zinc-300">{val} days</span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* Steps — rendered as markdown */}
                    {r.steps && (
                      <div className="px-4 py-3 border-t border-zinc-800">
                        <p className="text-xs font-medium text-zinc-500 mb-1.5">Brew Steps</p>
                        <div
                          className="text-xs text-zinc-400 leading-relaxed prose-steps"
                          dangerouslySetInnerHTML={{ __html: mdToHtml(r.steps) }}
                        />
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
              <Field label="Contract Brewing Partner">
                <select className="inp" value={form.partner_id}
                  onChange={(e) => setForm((f) => ({ ...f, partner_id: e.target.value }))}>
                  <option value="">— none (house brew) —</option>
                  {partners.map((p) => (
                    <option key={p.id} value={p.id}>{p.company_name}</option>
                  ))}
                </select>
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Expected Yield / Turn (BBL)" hint="for a 20 BBL brewhouse">
                <input
                  type="number" step="0.01" min="0" className="inp" placeholder="e.g. 18.5"
                  value={form.expected_yield_bbl}
                  onChange={(e) => setForm((f) => ({ ...f, expected_yield_bbl: e.target.value }))}
                />
              </Field>
              <Field label="Lead Time">
                <div className="inp flex items-center gap-2 bg-zinc-900/40 cursor-default select-none">
                  <span className="text-zinc-300 tabular-nums font-medium">
                    {(parseInt(form.days_brewhouse) || 0) + (parseInt(form.days_fermenter) || 0) + (parseInt(form.days_brite) || 0)} days
                  </span>
                  <span className="text-xs text-zinc-600">← auto-calculated from stage days below</span>
                </div>
              </Field>
            </div>

            <div>
              <p className="text-xs text-zinc-400 mb-2">Stage Duration (days)</p>
              <div className="grid grid-cols-3 gap-3">
                <Field label={<span className={`px-1.5 py-px rounded border text-xs ${STAGE_BADGES.brewhouse.badge}`}>{STAGE_BADGES.brewhouse.label}</span>}>
                  <input type="number" step="1" min="0" className="inp" placeholder="e.g. 1"
                    value={form.days_brewhouse}
                    onChange={(e) => setForm((f) => ({ ...f, days_brewhouse: e.target.value }))} />
                </Field>
                <Field label={<span className={`px-1.5 py-px rounded border text-xs ${STAGE_BADGES.fermenter.badge}`}>{STAGE_BADGES.fermenter.label}</span>}>
                  <input type="number" step="1" min="0" className="inp" placeholder="e.g. 14"
                    value={form.days_fermenter}
                    onChange={(e) => setForm((f) => ({ ...f, days_fermenter: e.target.value }))} />
                </Field>
                <Field label={<span className={`px-1.5 py-px rounded border text-xs ${STAGE_BADGES.brite.badge}`}>{STAGE_BADGES.brite.label}</span>}>
                  <input type="number" step="1" min="0" className="inp" placeholder="e.g. 7"
                    value={form.days_brite}
                    onChange={(e) => setForm((f) => ({ ...f, days_brite: e.target.value }))} />
                </Field>
              </div>
            </div>

            {/* Ingredient bill */}
            <div>
              <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <label className="text-xs text-zinc-400">Ingredient Bill</label>
                  <span className="text-xs text-zinc-600">(qty per turn)</span>
                  {/* Category filter */}
                  <div className="flex gap-1 flex-wrap">
                    <button type="button" onClick={() => setIngCatFilter("all")}
                      className={`text-xs px-2 py-0.5 rounded border transition-colors ${ingCatFilter === "all" ? "border-zinc-500 text-zinc-200 bg-zinc-800" : "border-zinc-700 text-zinc-600 hover:text-zinc-400"}`}>
                      All
                    </button>
                    {INGREDIENT_CATEGORIES.map((cat) => (
                      <button key={cat} type="button" onClick={() => setIngCatFilter(cat)}
                        className={`text-xs px-2 py-0.5 rounded border transition-colors ${ingCatFilter === cat ? "border-amber-600 bg-amber-900/30 text-amber-300" : "border-zinc-700 text-zinc-600 hover:text-zinc-400"}`}>
                        {cat}
                      </button>
                    ))}
                  </div>
                </div>
                {ingredients.length > 0 && (
                  <button type="button" onClick={addLine}
                    className="text-xs text-amber-500 hover:text-amber-400 transition-colors shrink-0">
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
                        <th className="px-3 py-2 text-xs font-medium text-zinc-500 text-right">Cost / Unit</th>
                        <th className="px-3 py-2 text-xs font-medium text-zinc-500 text-right">Qty / Turn</th>
                        <th className="px-3 py-2 text-xs font-medium text-zinc-500 text-right">$ / Turn</th>
                        <th className="px-3 py-2 w-6"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {lines.map((line, i) => {
                        const ing = ingredients.find((ing) => ing.id === line.ingredient_id);
                        const costPerTurnLine =
                          ing?.cost_per_unit != null && line.quantity_per_turn
                            ? ing.cost_per_unit * parseFloat(line.quantity_per_turn)
                            : null;
                        const displayIngredients = filteredIngredients.length > 0 ? filteredIngredients : ingredients;
                        return (
                          <tr key={i} className={`border-b border-zinc-800/60 ${i % 2 !== 0 ? "bg-zinc-900/20" : ""}`}>
                            <td className="px-3 py-1.5">
                              <select className="inp" value={line.ingredient_id}
                                onChange={(e) => setLines((ls) => ls.map((l, idx) => idx === i ? { ...l, ingredient_id: e.target.value } : l))}>
                                {displayIngredients.map((ing) => (
                                  <option key={ing.id} value={ing.id}>{ing.name} ({ing.unit})</option>
                                ))}
                              </select>
                            </td>
                            <td className="px-3 py-1.5 text-right text-xs text-zinc-500 tabular-nums whitespace-nowrap">
                              {ing?.cost_per_unit != null
                                ? `$${Number(ing.cost_per_unit).toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 })} / ${ing.unit}`
                                : "—"}
                            </td>
                            <td className="px-3 py-1.5">
                              <input type="number" step="0.0001" min="0" placeholder="qty/turn"
                                className="inp text-right" value={line.quantity_per_turn}
                                onChange={(e) => setLines((ls) => ls.map((l, idx) => idx === i ? { ...l, quantity_per_turn: e.target.value } : l))} />
                            </td>
                            <td className="px-3 py-1.5 text-right text-xs tabular-nums whitespace-nowrap">
                              {costPerTurnLine != null
                                ? <span className="text-zinc-300">${costPerTurnLine.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                                : <span className="text-zinc-600">—</span>}
                            </td>
                            <td className="px-3 py-1.5 text-center">
                              <button type="button" onClick={() => removeLine(i)}
                                className="text-zinc-600 hover:text-red-400 transition-colors">×</button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Brew Steps with live markdown preview */}
            <div>
              <label className="text-xs text-zinc-400 block mb-1.5">Brew Steps</label>
              <textarea
                className="inp resize-none font-mono text-xs"
                rows={6}
                placeholder={"1. Mash at 152°F for 60 min\n2. Sparge to collect 26 gal\n3. Boil 60 min…"}
                value={form.steps}
                onChange={(e) => setForm((f) => ({ ...f, steps: e.target.value }))}
              />
              {form.steps.trim() && (
                <div className="mt-1.5 p-3 rounded bg-zinc-900/60 border border-zinc-800">
                  <p className="text-xs text-zinc-600 mb-1">Preview</p>
                  <div className="text-xs text-zinc-400 leading-relaxed prose-steps"
                    dangerouslySetInnerHTML={{ __html: mdToHtml(form.steps) }} />
                </div>
              )}
            </div>

            <Field label="Notes">
              <textarea className="inp resize-none" rows={2} value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
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
