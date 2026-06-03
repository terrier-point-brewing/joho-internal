"use client";

import { useState, useEffect, useCallback } from "react";
import { Ingredient, StockAdjustment, AdjustmentType, Supplier, ContractBrewingPartner, IngredientCategory, INGREDIENT_CATEGORIES } from "../types";
import { Modal, Field, ModalActions } from "./shared";

const ADJUSTMENT_TYPES: {
  value: AdjustmentType;
  label: string;
  hint: string;
  sign: "positive" | "negative" | "count";
}[] = [
  { value: "received",        label: "Received",        hint: "Inventory received from supplier",  sign: "positive" },
  { value: "used",            label: "Used",            hint: "Manually recorded usage",           sign: "negative" },
  { value: "waste",           label: "Waste / Loss",    hint: "Spillage, spoilage, or write-off",  sign: "negative" },
  { value: "inventory_count", label: "Inventory Count", hint: "Enter the new actual stock total",  sign: "count"    },
];

const TYPE_COLORS: Record<AdjustmentType, string> = {
  received:        "text-green-400",
  used:            "text-zinc-400",
  waste:           "text-red-400",
  inventory_count: "text-blue-400",
  batch_use:       "text-amber-400",
};

const ING_EMPTY = { name: "", category: "" as IngredientCategory | "", supplier_id: "", partner_id: "", unit: "", cost_per_unit: "", stock_quantity: "0" };

function fmtQty(qty: number, sign = true) {
  const abs = Math.abs(qty).toLocaleString(undefined, { maximumFractionDigits: 3 });
  if (!sign) return abs;
  return qty >= 0 ? `+${abs}` : `-${abs}`;
}

function fmtValue(v: number | null | undefined) {
  if (v == null) return "—";
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function IngredientsTab({
  ingredients,
  adjustments,
  onRefresh,
  onAdjustmentsRefresh,
}: {
  ingredients: Ingredient[];
  adjustments: StockAdjustment[];
  onRefresh: () => Promise<void>;
  onAdjustmentsRefresh: () => Promise<void>;
}) {
  const [showIngModal, setShowIngModal] = useState(false);
  const [ingForm, setIngForm] = useState(ING_EMPTY);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [suppliersList, setSuppliersList] = useState<Supplier[]>([]);
  const [partnersList, setPartnersList] = useState<ContractBrewingPartner[]>([]);
  const loadSuppliersList = useCallback(async () => {
    const r = await fetch("/api/partners/suppliers"); if (r.ok) setSuppliersList(await r.json());
  }, []);
  const loadPartnersList = useCallback(async () => {
    const r = await fetch("/api/partners/contract-brewing"); if (r.ok) setPartnersList(await r.json());
  }, []);
  useEffect(() => { loadSuppliersList(); loadPartnersList(); }, [loadSuppliersList, loadPartnersList]);

  const [showAdjModal, setShowAdjModal] = useState(false);
  const [adjIngredient, setAdjIngredient] = useState<Ingredient | null>(null);
  const [adjType, setAdjType] = useState<AdjustmentType>("received");
  const [adjQty, setAdjQty] = useState("");
  const [adjPurchaseCost, setAdjPurchaseCost] = useState("");
  const [adjNote, setAdjNote] = useState("");
  const [adjSubmitting, setAdjSubmitting] = useState(false);

  const [logExpanded, setLogExpanded] = useState(false);
  const [logIngFilter, setLogIngFilter] = useState<string>("all");

  function openNew() { setIngForm(ING_EMPTY); setEditingId(null); setShowIngModal(true); }
  function openEdit(ing: Ingredient) {
    setIngForm({
      name: ing.name,
      category: ing.category ?? "",
      supplier_id: ing.supplier_id ?? "",
      partner_id: ing.partner_id ?? "",
      unit: ing.unit,
      cost_per_unit: ing.cost_per_unit != null ? String(ing.cost_per_unit) : "",
      stock_quantity: String(ing.stock_quantity),
    });
    setEditingId(ing.id);
    setShowIngModal(true);
  }

  async function handleIngSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const payload = {
        name: ingForm.name,
        category: ingForm.category || null,
        supplier_id: ingForm.supplier_id || null,
        partner_id: ingForm.partner_id || null,
        unit: ingForm.unit,
        cost_per_unit: ingForm.cost_per_unit !== "" ? parseFloat(ingForm.cost_per_unit) : null,
        stock_quantity: parseFloat(ingForm.stock_quantity) || 0,
      };
      const res = editingId
        ? await fetch(`/api/production/ingredients/${editingId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
        : await fetch("/api/production/ingredients",              { method: "POST",  headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      setShowIngModal(false);
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

  function openAdj(ing: Ingredient) {
    setAdjIngredient(ing);
    setAdjType("received");
    setAdjQty("");
    setAdjPurchaseCost("");
    setAdjNote("");
    setShowAdjModal(true);
  }

  async function handleAdjSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!adjIngredient) return;
    setAdjSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        ingredient_id: adjIngredient.id,
        type: adjType,
        note: adjNote || null,
      };
      if (adjType === "inventory_count") {
        body.new_total = parseFloat(adjQty);
      } else {
        body.quantity = parseFloat(adjQty);
      }
      if (adjType === "received" && adjPurchaseCost !== "") {
        body.purchase_cost = parseFloat(adjPurchaseCost);
      }
      const res = await fetch("/api/production/stock-adjustments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      setShowAdjModal(false);
      await Promise.all([onRefresh(), onAdjustmentsRefresh()]);
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Error");
    } finally {
      setAdjSubmitting(false);
    }
  }

  const adjTypeMeta = ADJUSTMENT_TYPES.find((t) => t.value === adjType);
  const filteredLog = logIngFilter === "all"
    ? adjustments
    : adjustments.filter((a) => a.ingredient_id === logIngFilter);

  // Preview calculations for "received" type
  const previewQty  = parseFloat(adjQty) || 0;
  const previewCost = parseFloat(adjPurchaseCost) || 0;
  const currentStock = adjIngredient?.stock_quantity ?? 0;
  const currentCost  = adjIngredient?.cost_per_unit ?? null;
  const currentValue = currentCost != null ? currentStock * currentCost : null;
  const newStock     = currentStock + previewQty;
  const newCostPerUnit = adjType === "received" && previewCost > 0 && previewQty > 0 && newStock > 0
    ? ((currentStock * (currentCost ?? 0)) + (previewQty * previewCost)) / newStock
    : currentCost;
  const newValue = newCostPerUnit != null ? newStock * newCostPerUnit : null;

  return (
    <>
      <div className="flex justify-end mb-4">
        <button onClick={openNew} className="btn-amber">+ New Ingredient</button>
      </div>

      {ingredients.length === 0 ? (
        <p className="text-zinc-600 text-sm">No ingredients yet.</p>
      ) : (
        <div className="space-y-6">
          {(() => {
            const categorized = INGREDIENT_CATEGORIES.map((cat) => ({
              cat,
              items: ingredients.filter((i) => i.category === cat),
            })).filter((g) => g.items.length > 0);
            const uncategorized = ingredients.filter((i) => !i.category);
            const groups = [...categorized, ...(uncategorized.length ? [{ cat: "Uncategorized" as const, items: uncategorized }] : [])];

            return groups.map(({ cat, items }) => (
              <div key={cat}>
                <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2 px-1">{cat}</h3>
                <div className="overflow-x-auto rounded-lg border border-zinc-800">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-zinc-800 bg-zinc-900/50 text-left">
                        {["Name", "Supplier", "Partner", "Unit", "Cost / Unit", "Stock", "Total Value", ""].map((h) => (
                          <th key={h} className={`px-4 py-2.5 text-xs font-medium text-zinc-500 ${
                            ["Cost / Unit", "Stock", "Total Value"].includes(h) ? "text-right" : ""
                          }`}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((ing, i) => {
                        const totalValue = ing.cost_per_unit != null
                          ? ing.cost_per_unit * ing.stock_quantity
                          : null;
                        return (
                          <tr key={ing.id} className={`border-b border-zinc-800/60 ${i % 2 !== 0 ? "bg-zinc-900/30" : ""}`}>
                            <td className="px-4 py-2.5 text-zinc-100 font-medium">{ing.name}</td>
                            <td className="px-4 py-2.5 text-zinc-400">{ing.suppliers?.company_name ?? "—"}</td>
                            <td className="px-4 py-2.5 text-zinc-400">{ing.contract_brewing_partners?.company_name ?? "—"}</td>
                            <td className="px-4 py-2.5 text-zinc-400">{ing.unit}</td>
                            <td className="px-4 py-2.5 text-zinc-300 text-right tabular-nums">
                              {ing.cost_per_unit != null ? `$${Number(ing.cost_per_unit).toFixed(4)}` : "—"}
                            </td>
                            <td className="px-4 py-2.5 text-right tabular-nums">
                              <span className={Number(ing.stock_quantity) < 0 ? "text-red-400" : "text-zinc-300"}>
                                {Number(ing.stock_quantity).toLocaleString(undefined, { maximumFractionDigits: 3 })} {ing.unit}
                              </span>
                            </td>
                            <td className="px-4 py-2.5 text-right tabular-nums text-zinc-300">
                              {fmtValue(totalValue)}
                            </td>
                            <td className="px-4 py-2.5">
                              <div className="flex gap-3 justify-end">
                                <button onClick={() => openAdj(ing)} className="text-xs text-amber-500 hover:text-amber-400 transition-colors font-medium">Adjust</button>
                                <button onClick={() => openEdit(ing)} className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors">Edit</button>
                                <button onClick={() => handleDelete(ing.id, ing.name)} className="text-xs text-zinc-600 hover:text-red-400 transition-colors">Delete</button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ));
          })()}
        </div>
      )}

      {/* Adjustment Log */}
      <div className="mt-8">
        <button
          onClick={() => setLogExpanded((v) => !v)}
          className="flex items-center gap-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors mb-3"
        >
          <span>{logExpanded ? "▼" : "▶"}</span>
          <span>Stock Adjustment Log ({adjustments.length})</span>
        </button>

        {logExpanded && (
          <div>
            <div className="flex items-center gap-3 mb-3">
              <label className="text-xs text-zinc-500">Filter by ingredient:</label>
              <select className="inp w-48" value={logIngFilter} onChange={(e) => setLogIngFilter(e.target.value)}>
                <option value="all">All ingredients</option>
                {ingredients.map((ing) => (
                  <option key={ing.id} value={ing.id}>{ing.name}</option>
                ))}
              </select>
            </div>

            {filteredLog.length === 0 ? (
              <p className="text-zinc-600 text-sm">No adjustments recorded.</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-zinc-800">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-zinc-800 bg-zinc-900/50 text-left">
                      {["Date", "Ingredient", "Type", "Change", "Unit Cost", "Value Δ", "Note", "Batch"].map((h) => (
                        <th key={h} className={`px-4 py-2.5 text-xs font-medium text-zinc-500 ${["Change", "Unit Cost", "Value Δ"].includes(h) ? "text-right" : ""}`}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredLog.map((adj, i) => {
                      const ing = ingredients.find((ing) => ing.id === adj.ingredient_id);
                      return (
                        <tr key={adj.id} className={`border-b border-zinc-800/60 ${i % 2 !== 0 ? "bg-zinc-900/30" : ""}`}>
                          <td className="px-4 py-2 text-zinc-500 text-xs whitespace-nowrap">
                            {new Date(adj.created_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                          </td>
                          <td className="px-4 py-2 text-zinc-300">{adj.ingredients?.name ?? ing?.name ?? "—"}</td>
                          <td className="px-4 py-2">
                            <span className={`text-xs font-medium ${TYPE_COLORS[adj.type]}`}>
                              {ADJUSTMENT_TYPES.find((t) => t.value === adj.type)?.label ?? adj.type}
                            </span>
                          </td>
                          <td className={`px-4 py-2 text-right tabular-nums text-xs font-mono ${adj.quantity >= 0 ? "text-green-400" : "text-red-400"}`}>
                            {fmtQty(adj.quantity)} {ing?.unit ?? adj.ingredients?.unit ?? ""}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums text-xs text-zinc-400">
                            {adj.cost_per_unit != null ? `$${Number(adj.cost_per_unit).toFixed(4)}` : "—"}
                          </td>
                          <td className={`px-4 py-2 text-right tabular-nums text-xs font-mono ${
                            adj.total_value_change == null ? "text-zinc-600"
                              : adj.total_value_change >= 0 ? "text-green-400" : "text-red-400"
                          }`}>
                            {adj.total_value_change != null
                              ? (adj.total_value_change >= 0 ? "+" : "") + fmtValue(adj.total_value_change)
                              : "—"}
                          </td>
                          <td className="px-4 py-2 text-zinc-500 text-xs max-w-[160px] truncate">{adj.note ?? "—"}</td>
                          <td className="px-4 py-2 text-zinc-600 text-xs font-mono">
                            {adj.brew_batches?.batch_number ?? "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Ingredient modal */}
      {showIngModal && (
        <Modal title={editingId ? "Edit Ingredient" : "New Ingredient"} onClose={() => setShowIngModal(false)}>
          <form onSubmit={handleIngSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Name" required>
                <input className="inp" value={ingForm.name} required
                  onChange={(e) => setIngForm((f) => ({ ...f, name: e.target.value }))} />
              </Field>
              <Field label="Category">
                <select className="inp" value={ingForm.category}
                  onChange={(e) => setIngForm((f) => ({ ...f, category: e.target.value as IngredientCategory | "" }))}>
                  <option value="">— none —</option>
                  {INGREDIENT_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Supplier">
                <select className="inp" value={ingForm.supplier_id}
                  onChange={(e) => setIngForm((f) => ({ ...f, supplier_id: e.target.value }))}>
                  <option value="">— none —</option>
                  {suppliersList.map((s) => <option key={s.id} value={s.id}>{s.company_name}</option>)}
                </select>
              </Field>
              <Field label="Partner (contract brewer)">
                <select className="inp" value={ingForm.partner_id}
                  onChange={(e) => setIngForm((f) => ({ ...f, partner_id: e.target.value }))}>
                  <option value="">— none —</option>
                  {partnersList.map((p) => <option key={p.id} value={p.id}>{p.company_name}</option>)}
                </select>
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Unit" required>
                <input className="inp" placeholder="lb, oz, each…" value={ingForm.unit} required
                  onChange={(e) => setIngForm((f) => ({ ...f, unit: e.target.value }))} />
              </Field>
              <Field label="Cost per Unit ($)">
                <input type="number" step="0.0001" min="0" className="inp" placeholder="0.0000"
                  value={ingForm.cost_per_unit}
                  onChange={(e) => setIngForm((f) => ({ ...f, cost_per_unit: e.target.value }))} />
              </Field>
            </div>
            <Field label="Starting Stock">
              <input type="number" step="0.001" min="0" className="inp" value={ingForm.stock_quantity}
                onChange={(e) => setIngForm((f) => ({ ...f, stock_quantity: e.target.value }))} />
            </Field>
            <ModalActions submitting={submitting} onCancel={() => setShowIngModal(false)}
              label={editingId ? "Save Changes" : "Add Ingredient"} />
          </form>
        </Modal>
      )}

      {/* Adjustment modal */}
      {showAdjModal && adjIngredient && (
        <Modal title={`Adjust Stock — ${adjIngredient.name}`} onClose={() => setShowAdjModal(false)}>
          <form onSubmit={handleAdjSubmit} className="space-y-4">
            {/* Current state summary */}
            <div className="p-3 bg-zinc-800/50 rounded text-sm grid grid-cols-3 gap-4">
              <div>
                <p className="text-xs text-zinc-500 mb-0.5">Current stock</p>
                <p className="text-zinc-100 font-medium">
                  {Number(adjIngredient.stock_quantity).toLocaleString(undefined, { maximumFractionDigits: 3 })} {adjIngredient.unit}
                </p>
              </div>
              <div>
                <p className="text-xs text-zinc-500 mb-0.5">Unit cost</p>
                <p className="text-zinc-100 font-medium">
                  {adjIngredient.cost_per_unit != null ? `$${Number(adjIngredient.cost_per_unit).toFixed(4)}` : "—"}
                </p>
              </div>
              <div>
                <p className="text-xs text-zinc-500 mb-0.5">Total value</p>
                <p className="text-zinc-100 font-medium">{fmtValue(currentValue)}</p>
              </div>
            </div>

            <Field label="Adjustment Type" required>
              <div className="grid grid-cols-2 gap-2">
                {ADJUSTMENT_TYPES.map((t) => (
                  <button key={t.value} type="button" onClick={() => setAdjType(t.value)}
                    className={`px-3 py-2 rounded border text-sm text-left transition-colors ${
                      adjType === t.value
                        ? "border-amber-600 bg-amber-900/30 text-amber-300"
                        : "border-zinc-700 bg-zinc-800/50 text-zinc-400 hover:border-zinc-500"
                    }`}
                  >
                    <div className="font-medium">{t.label}</div>
                    <div className="text-xs opacity-70 mt-0.5">{t.hint}</div>
                  </button>
                ))}
              </div>
            </Field>

            <Field
              label={adjType === "inventory_count" ? `New Stock Total (${adjIngredient.unit})` : `Quantity (${adjIngredient.unit})`}
              required
            >
              <input type="number" step="0.001" min="0" className="inp"
                placeholder={adjType === "inventory_count" ? "Enter new total" : "Enter quantity"}
                value={adjQty} required onChange={(e) => setAdjQty(e.target.value)} />
              {adjQty && adjType !== "inventory_count" && (
                <p className="text-xs mt-1 text-zinc-500">
                  {adjTypeMeta?.sign === "positive" ? "Adds" : "Removes"}{" "}
                  <span className={adjTypeMeta?.sign === "positive" ? "text-green-400" : "text-red-400"}>
                    {adjQty} {adjIngredient.unit}
                  </span>{" "}
                  → new total:{" "}
                  <span className="text-zinc-300">
                    {(adjIngredient.stock_quantity + (adjTypeMeta?.sign === "positive" ? 1 : -1) * parseFloat(adjQty || "0"))
                      .toLocaleString(undefined, { maximumFractionDigits: 3 })}{" "}
                    {adjIngredient.unit}
                  </span>
                </p>
              )}
            </Field>

            {/* Purchase cost — only shown for "received" */}
            {adjType === "received" && (
              <Field label="Purchase Cost ($ per unit)">
                <input type="number" step="0.0001" min="0" className="inp" placeholder="0.0000"
                  value={adjPurchaseCost} onChange={(e) => setAdjPurchaseCost(e.target.value)} />
                {previewQty > 0 && previewCost > 0 && (
                  <div className="mt-2 p-2.5 rounded bg-zinc-800/60 border border-zinc-700 text-xs space-y-1">
                    <p className="text-zinc-400 font-medium mb-1">After this receipt:</p>
                    <div className="flex justify-between">
                      <span className="text-zinc-500">Unit cost</span>
                      <span className="text-zinc-200">
                        {currentCost != null ? `$${Number(currentCost).toFixed(4)}` : "—"}
                        {" → "}
                        <span className="text-green-300">${Number(newCostPerUnit).toFixed(4)}</span>
                        {" (weighted avg)"}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-zinc-500">Total value</span>
                      <span className="text-zinc-200">
                        {fmtValue(currentValue)}
                        {" → "}
                        <span className="text-green-300">{fmtValue(newValue)}</span>
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-zinc-500">Receipt value</span>
                      <span className="text-green-400">+{fmtValue(previewQty * previewCost)}</span>
                    </div>
                  </div>
                )}
              </Field>
            )}

            <Field label="Note">
              <input className="inp" placeholder="Optional reason or reference"
                value={adjNote} onChange={(e) => setAdjNote(e.target.value)} />
            </Field>

            <ModalActions submitting={adjSubmitting} onCancel={() => setShowAdjModal(false)} label="Record Adjustment" />
          </form>
        </Modal>
      )}
    </>
  );
}
