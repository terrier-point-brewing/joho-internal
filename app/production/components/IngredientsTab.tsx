"use client";

import { useState, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Ingredient, AdjustmentType, IngredientCategory, INGREDIENT_CATEGORIES } from "../types";
import { Modal, Field, ModalActions } from "./shared";
import { useContractPartnersQuery, useSuppliersQuery, useIngredientsQuery, productionKeys } from "../hooks/queries";
import { fmtUsd } from "@/lib/utils/formatting";

const INGREDIENT_CATEGORY_META: Record<IngredientCategory, { color: string }> = {
  "Malts":        { color: "border-amber-700 bg-amber-900/30 text-amber-300" },
  "Hops":         { color: "border-green-700 bg-green-900/30 text-green-300" },
  "Yeast":        { color: "border-yellow-700 bg-yellow-900/30 text-yellow-300" },
  "Brewing Aids": { color: "border-blue-700 bg-blue-900/30 text-blue-300" },
  "Fruit":        { color: "border-rose-700 bg-rose-900/30 text-rose-300" },
  "Abstrax":      { color: "border-purple-700 bg-purple-900/30 text-purple-300" },
};

// ─── CSV bulk upload ──────────────────────────────────────────────────────────

const BULK_COLUMNS = ["name", "category", "unit", "cost_per_unit", "stock_quantity"] as const;
type BulkCol = typeof BULK_COLUMNS[number];

interface ParsedRow {
  name: string;
  category: string;
  unit: string;
  cost_per_unit: string;
  stock_quantity: string;
  _errors: string[];
}

const TEMPLATE_CSV =
  "name,category,unit,cost_per_unit,stock_quantity\n" +
  "Cascade Hops,Hops,oz,0.45,240\n" +
  "Pale Malt 2-Row,Malt,lb,0.85,500\n";

const VALID_CATEGORIES = new Set<string>(INGREDIENT_CATEGORIES);

/** Splits one CSV line into fields, correctly handling quoted fields with embedded commas. */
function splitCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === "," && !inQuotes) {
      fields.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

function parseCSV(text: string): ParsedRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return [];

  // Detect if first line is a header by checking if "name" appears
  const firstCols = splitCSVLine(lines[0]).map((c) => c.toLowerCase());
  const hasHeader = firstCols.includes("name");
  const dataLines = hasHeader ? lines.slice(1) : lines;

  // Build column index map from header (or assume positional)
  const colIndex: Record<BulkCol, number> = { name: 0, category: 1, unit: 2, cost_per_unit: 3, stock_quantity: 4 };
  if (hasHeader) {
    BULK_COLUMNS.forEach((col) => {
      const idx = firstCols.indexOf(col);
      if (idx !== -1) colIndex[col] = idx;
    });
  }

  return dataLines
    .filter((l) => l.trim())
    .map((line) => {
      const cols = splitCSVLine(line);

      const get = (col: BulkCol) => cols[colIndex[col]]?.trim() ?? "";

      const name          = get("name");
      const category      = get("category");
      const unit          = get("unit");
      const cost_per_unit = get("cost_per_unit");
      const stock_quantity = get("stock_quantity");

      const errors: string[] = [];
      if (!name)  errors.push("name is required");
      if (!unit)  errors.push("unit is required");
      if (cost_per_unit && isNaN(parseFloat(cost_per_unit)))
        errors.push("cost_per_unit must be a number");
      if (stock_quantity && isNaN(parseFloat(stock_quantity)))
        errors.push("stock_quantity must be a number");
      if (category && !VALID_CATEGORIES.has(category))
        errors.push(`unknown category "${category}"`);

      return { name, category, unit, cost_per_unit, stock_quantity, _errors: errors };
    });
}

function BulkUploadModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [csvText, setCsvText]         = useState("");
  const [rows, setRows]               = useState<ParsedRow[]>([]);
  const [parsed, setParsed]           = useState(false);
  const [submitting, setSubmitting]   = useState(false);
  const [result, setResult]           = useState<{ inserted: number } | null>(null);
  const [error, setError]             = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function handleTextChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setCsvText(e.target.value);
    setParsed(false);
    setRows([]);
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      setCsvText(text);
      setParsed(false);
      setRows([]);
    };
    reader.readAsText(file);
  }

  function handleParse() {
    const r = parseCSV(csvText);
    setRows(r);
    setParsed(true);
  }

  async function handleImport() {
    const validRows = rows.filter((r) => r._errors.length === 0);
    if (validRows.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const payload = validRows.map((r) => ({
        name:           r.name,
        category:       r.category || null,
        unit:           r.unit,
        cost_per_unit:  r.cost_per_unit ? parseFloat(r.cost_per_unit) : null,
        stock_quantity: r.stock_quantity ? parseFloat(r.stock_quantity) : 0,
      }));
      const res = await fetch("/api/production/ingredients/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: payload }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Import failed");
      setResult(await res.json());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setSubmitting(false);
    }
  }

  const validCount   = rows.filter((r) => r._errors.length === 0).length;
  const invalidCount = rows.filter((r) => r._errors.length > 0).length;

  if (result) {
    return (
      <Modal title="Bulk Upload Complete" onClose={onDone}>
        <div className="space-y-4 text-center py-4">
          <p className="text-4xl">✓</p>
          <p className="text-zinc-100 font-medium">{result.inserted} ingredient{result.inserted !== 1 ? "s" : ""} imported</p>
          {invalidCount > 0 && (
            <p className="text-xs text-zinc-500">{invalidCount} row{invalidCount !== 1 ? "s" : ""} with errors were skipped.</p>
          )}
          <button onClick={onDone} className="btn-amber mx-auto block">Done</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Bulk Upload Ingredients" onClose={onClose}>
      <div className="space-y-4">
        <p className="text-xs text-zinc-500">
          Upload a CSV file or paste CSV text. Columns:{" "}
          <span className="font-mono text-zinc-400">name</span>,{" "}
          <span className="font-mono text-zinc-400">category</span>,{" "}
          <span className="font-mono text-zinc-400">unit</span>,{" "}
          <span className="font-mono text-zinc-400">cost_per_unit</span>,{" "}
          <span className="font-mono text-zinc-400">stock_quantity</span>.
          A header row is optional.
        </p>

        {/* File picker */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="px-3 py-1.5 text-xs rounded border border-zinc-700 bg-zinc-800 text-zinc-300 hover:text-zinc-100 transition-colors"
          >
            Choose CSV file…
          </button>
          <button
            type="button"
            onClick={() => { setCsvText(TEMPLATE_CSV); setParsed(false); setRows([]); }}
            className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
          >
            Load example
          </button>
          <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={handleFile} />
        </div>

        {/* Paste area */}
        <Field label="CSV text">
          <textarea
            className="inp font-mono text-xs resize-none"
            rows={6}
            placeholder={"name,category,unit,cost_per_unit,stock_quantity\nCascade Hops,Hops,oz,0.45,240"}
            value={csvText}
            onChange={handleTextChange}
          />
        </Field>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleParse}
            disabled={!csvText.trim()}
            className="px-3 py-1.5 text-sm rounded border border-zinc-700 bg-zinc-800 text-zinc-300 hover:text-zinc-100 disabled:opacity-40 transition-colors"
          >
            Preview
          </button>
          {parsed && rows.length > 0 && (
            <span className="text-xs text-zinc-500">
              {validCount} valid
              {invalidCount > 0 && <span className="text-red-400 ml-1">· {invalidCount} with errors</span>}
            </span>
          )}
        </div>

        {error && <p className="text-xs text-red-400">{error}</p>}

        {/* Preview table */}
        {parsed && rows.length > 0 && (
          <div className="border border-zinc-800 rounded-lg overflow-hidden max-h-64 overflow-y-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-zinc-800 bg-zinc-900/70 text-left">
                  <th className="px-3 py-2 text-zinc-500 font-medium w-5"></th>
                  <th className="px-3 py-2 text-zinc-500 font-medium">Name</th>
                  <th className="px-3 py-2 text-zinc-500 font-medium">Category</th>
                  <th className="px-3 py-2 text-zinc-500 font-medium">Unit</th>
                  <th className="px-3 py-2 text-zinc-500 font-medium text-right">Cost/Unit</th>
                  <th className="px-3 py-2 text-zinc-500 font-medium text-right">Stock</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr
                    key={i}
                    className={`border-b border-zinc-800/60 last:border-0 ${
                      r._errors.length > 0 ? "bg-red-950/30" : i % 2 !== 0 ? "bg-zinc-900/30" : ""
                    }`}
                    title={r._errors.length > 0 ? r._errors.join("; ") : undefined}
                  >
                    <td className="px-3 py-1.5 text-center">
                      {r._errors.length > 0 ? (
                        <span className="text-red-400" title={r._errors.join("; ")}>✕</span>
                      ) : (
                        <span className="text-green-500">✓</span>
                      )}
                    </td>
                    <td className={`px-3 py-1.5 font-medium ${r._errors.length > 0 ? "text-red-300" : "text-zinc-200"}`}>{r.name || <span className="text-zinc-700">—</span>}</td>
                    <td className="px-3 py-1.5 text-zinc-400">{r.category || <span className="text-zinc-700">—</span>}</td>
                    <td className="px-3 py-1.5 text-zinc-400">{r.unit || <span className="text-zinc-700">—</span>}</td>
                    <td className="px-3 py-1.5 text-right text-zinc-400 tabular-nums">{r.cost_per_unit || <span className="text-zinc-700">—</span>}</td>
                    <td className="px-3 py-1.5 text-right text-zinc-400 tabular-nums">{r.stock_quantity || "0"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {invalidCount > 0 && (
              <p className="px-3 py-2 text-xs text-red-400 border-t border-zinc-800">
                Rows with errors (shown in red) will be skipped. Hover a row to see the error.
              </p>
            )}
          </div>
        )}

        {parsed && rows.length === 0 && (
          <p className="text-xs text-zinc-600">No rows found — check your CSV format.</p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="btn-ghost text-sm" disabled={submitting}>
            Cancel
          </button>
          <button
            type="button"
            onClick={handleImport}
            disabled={!parsed || validCount === 0 || submitting}
            className="btn-amber disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {submitting ? "Importing…" : `Import ${validCount > 0 ? validCount : ""} Ingredient${validCount !== 1 ? "s" : ""}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}

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

const ING_EMPTY = { name: "", category: "" as IngredientCategory | "", supplier_id: "", partner_id: "", unit: "", cost_per_unit: "", stock_quantity: "0", alpha_acid: "", color_lovibond: "" };

function fmtValue(v: number | null | undefined) {
  if (v == null) return "—";
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function IngredientsTab() {
  const qc = useQueryClient();
  const { data: ingredients = [] } = useIngredientsQuery();
  const { data: suppliersList = [] } = useSuppliersQuery();
  const { data: partnersList = [] } = useContractPartnersQuery();
  const onRefresh = () => qc.invalidateQueries({ queryKey: productionKeys.ingredients });
  const onAdjustmentsRefresh = () => qc.invalidateQueries({ queryKey: productionKeys.adjustments });

  const [showBulkModal, setShowBulkModal] = useState(false);
  const [showIngModal, setShowIngModal] = useState(false);
  const [ingForm, setIngForm] = useState(ING_EMPTY);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [showAdjModal, setShowAdjModal] = useState(false);
  const [adjIngredient, setAdjIngredient] = useState<Ingredient | null>(null);
  const [adjType, setAdjType] = useState<AdjustmentType>("received");
  const [adjQty, setAdjQty] = useState("");
  const [adjPurchaseCost, setAdjPurchaseCost] = useState("");
  const [adjShippingCost, setAdjShippingCost] = useState("");
  const [adjNote, setAdjNote] = useState("");
  const [adjSubmitting, setAdjSubmitting] = useState(false);


  // Category filter
  const [filterCat, setFilterCat] = useState<IngredientCategory | "all">("all");

  // Bulk edit
  type BulkRow = { id: string; name: string; unit: string; cost_per_unit: string };
  const [bulkEditMode, setBulkEditMode] = useState(false);
  const [bulkRows, setBulkRows] = useState<BulkRow[]>([]);
  const [bulkSaving, setBulkSaving] = useState(false);

  function enterBulkEdit() {
    setBulkRows(
      ingredients.map((ing) => ({
        id: ing.id,
        name: ing.name,
        unit: ing.unit,
        cost_per_unit: ing.cost_per_unit != null ? String(ing.cost_per_unit) : "",
      }))
    );
    setBulkEditMode(true);
  }

  async function saveBulkEdit() {
    setBulkSaving(true);
    try {
      await Promise.all(
        bulkRows.map((row) => {
          const orig = ingredients.find((i) => i.id === row.id);
          if (
            orig?.name === row.name &&
            orig?.unit === row.unit &&
            String(orig?.cost_per_unit ?? "") === row.cost_per_unit
          )
            return Promise.resolve();
          return fetch(`/api/production/ingredients/${row.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: row.name,
              category: orig?.category ?? null,
              supplier_id: orig?.supplier_id ?? null,
              partner_id: orig?.partner_id ?? null,
              unit: row.unit,
              cost_per_unit: row.cost_per_unit !== "" ? parseFloat(row.cost_per_unit) : null,
              stock_quantity: orig?.stock_quantity ?? 0,
            }),
          });
        })
      );
      setBulkEditMode(false);
      await onRefresh();
    } catch {
      alert("Some saves failed — check network");
    } finally {
      setBulkSaving(false);
    }
  }

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
      alpha_acid: ing.alpha_acid != null ? String(ing.alpha_acid) : "",
      color_lovibond: ing.color_lovibond != null ? String(ing.color_lovibond) : "",
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
        alpha_acid: ingForm.alpha_acid !== "" ? parseFloat(ingForm.alpha_acid) : null,
        color_lovibond: ingForm.color_lovibond !== "" ? parseFloat(ingForm.color_lovibond) : null,
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
    const res = await fetch(`/api/production/ingredients/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      alert(body?.error ?? "Delete failed");
      return;
    }
    await onRefresh();
  }

  function openAdj(ing: Ingredient) {
    setAdjIngredient(ing);
    setAdjType("received");
    setAdjQty("");
    setAdjPurchaseCost("");
    setAdjShippingCost("");
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
      if (adjType === "received" && adjShippingCost !== "") {
        body.shipping_cost = parseFloat(adjShippingCost);
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
      {/* Category pills + action buttons inline */}
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={() => setFilterCat("all")}
            className={`text-xs px-2.5 py-1 rounded border transition-colors ${filterCat === "all" ? "border-zinc-500 text-zinc-200 bg-zinc-800" : "border-zinc-700 text-zinc-500 hover:text-zinc-300"}`}
          >
            All
          </button>
          {INGREDIENT_CATEGORIES.map((cat) => {
            const meta = INGREDIENT_CATEGORY_META[cat];
            return (
              <button key={cat} onClick={() => setFilterCat(cat)}
                className={`text-xs px-2.5 py-1 rounded border transition-colors ${filterCat === cat ? meta.color : "border-zinc-700 text-zinc-500 hover:text-zinc-300"}`}
              >
                {cat}
              </button>
            );
          })}
        </div>
        <div className="flex gap-2 shrink-0">
          {bulkEditMode ? (
            <>
              <button onClick={() => setBulkEditMode(false)} className="btn-ghost text-sm" disabled={bulkSaving}>Cancel</button>
              <button onClick={saveBulkEdit} className="btn-amber" disabled={bulkSaving}>
                {bulkSaving ? "Saving…" : "Save All"}
              </button>
            </>
          ) : (
            <>
              <button onClick={enterBulkEdit} className="btn-ghost text-sm" disabled={ingredients.length === 0}>Bulk Edit</button>
              <button onClick={() => setShowBulkModal(true)} className="btn-amber">↑ Bulk Upload</button>
              <button onClick={openNew} className="btn-amber">+ New Ingredient</button>
            </>
          )}
        </div>
      </div>

      {ingredients.length === 0 ? (
        <p className="text-zinc-600 text-sm">No ingredients yet.</p>
      ) : (
        <div className="space-y-6">
          {(() => {
            const allGroups = INGREDIENT_CATEGORIES.map((cat) => ({
              cat,
              items: ingredients.filter((i) => i.category === cat),
            })).filter((g) => g.items.length > 0);
            const uncategorized = ingredients.filter((i) => !i.category);
            const groups = [...allGroups, ...(uncategorized.length ? [{ cat: "Uncategorized" as const, items: uncategorized }] : [])];
            const visibleGroups = filterCat === "all" ? groups : groups.filter((g) => g.cat === filterCat);

            return visibleGroups.map(({ cat, items }) => {
              const showAlphaAcid     = cat === "Hops";
              const showColorLovibond = cat === "Malts";
              const catMeta = cat !== "Uncategorized" ? INGREDIENT_CATEGORY_META[cat as IngredientCategory] : null;
              return (
              <div key={cat}>
                {/* Group header — same pill style as PackagingTab */}
                <div className="flex items-center gap-2 mb-2">
                  <span className={`text-xs px-2 py-px rounded border ${catMeta?.color ?? "border-zinc-700 bg-zinc-800/40 text-zinc-400"}`}>
                    {cat}
                  </span>
                  <span className="text-xs text-zinc-600">{items.length} item{items.length !== 1 ? "s" : ""}</span>
                </div>
                <div className="overflow-x-auto rounded-lg border border-zinc-800">
                  {/* Shared fixed column widths — identical across all category tables so
                      columns align vertically when tables are stacked. Specialty columns
                      (AA%, °L) are appended after Total Value only for relevant categories. */}
                  <table className="w-full text-sm table-fixed min-w-[780px]">
                    <colgroup>
                      <col style={{ width: "18%" }} />{/* Name */}
                      <col style={{ width: "12%" }} />{/* Supplier */}
                      <col style={{ width: "11%" }} />{/* Partner */}
                      <col style={{ width: "7%"  }} />{/* AA% or °L — always present for alignment */}
                      <col style={{ width: "5%"  }} />{/* Unit */}
                      <col style={{ width: "9%"  }} />{/* Cost/Unit */}
                      <col style={{ width: "10%" }} />{/* Stock */}
                      <col style={{ width: "10%" }} />{/* Total Value */}
                      <col style={{ width: "18%" }} />{/* Actions */}
                    </colgroup>
                    <thead>
                      <tr className="border-b border-zinc-800 bg-zinc-900/50 text-left">
                        <th className="px-3 py-2.5 text-xs font-medium text-zinc-500">Name</th>
                        <th className="px-3 py-2.5 text-xs font-medium text-zinc-500">Supplier</th>
                        <th className="px-3 py-2.5 text-xs font-medium text-zinc-500">Partner</th>
                        <th className="px-3 py-2.5 text-xs font-medium text-zinc-500 text-right whitespace-nowrap">
                          {showAlphaAcid ? "AA%" : showColorLovibond ? "°L" : ""}
                        </th>
                        <th className="px-3 py-2.5 text-xs font-medium text-zinc-500">Unit</th>
                        <th className="px-3 py-2.5 text-xs font-medium text-zinc-500 text-right whitespace-nowrap">Cost / Unit</th>
                        <th className="px-3 py-2.5 text-xs font-medium text-zinc-500 text-right">Stock</th>
                        <th className="px-3 py-2.5 text-xs font-medium text-zinc-500 text-right whitespace-nowrap">Total Value</th>
                        <th className="px-3 py-2.5 text-xs font-medium text-zinc-500"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((ing, i) => {
                        const totalValue = ing.cost_per_unit != null ? ing.cost_per_unit * ing.stock_quantity : null;
                        const bulkRow = bulkRows.find((r) => r.id === ing.id);
                        if (bulkEditMode && bulkRow) {
                          return (
                            <tr key={ing.id} className={`border-b border-zinc-800/60 ${i % 2 !== 0 ? "bg-zinc-900/30" : ""}`}>
                              <td className="px-2 py-1.5">
                                <input className="inp text-sm w-full" value={bulkRow.name}
                                  onChange={(e) => setBulkRows((rs) => rs.map((r) => r.id === ing.id ? { ...r, name: e.target.value } : r))} />
                              </td>
                              <td className="px-2 py-1.5 text-zinc-400 truncate">{ing.suppliers?.company_name ?? "—"}</td>
                              <td className="px-2 py-1.5 text-zinc-400 truncate">{ing.contract_brewing_partners?.company_name ?? "—"}</td>
                              <td className="px-3 py-2.5 text-zinc-600 text-xs text-right">—</td>
                              <td className="px-2 py-1.5">
                                <input className="inp text-sm w-full" value={bulkRow.unit}
                                  onChange={(e) => setBulkRows((rs) => rs.map((r) => r.id === ing.id ? { ...r, unit: e.target.value } : r))} />
                              </td>
                              <td className="px-2 py-1.5">
                                <input type="number" step="0.0001" min="0" className="inp text-sm w-full text-right tabular-nums" placeholder="0.0000" value={bulkRow.cost_per_unit}
                                  onChange={(e) => setBulkRows((rs) => rs.map((r) => r.id === ing.id ? { ...r, cost_per_unit: e.target.value } : r))} />
                              </td>
                              <td className="px-4 py-2.5 text-right tabular-nums">
                                <span className={Number(ing.stock_quantity) < 0 ? "text-red-400" : "text-zinc-300"}>
                                  {Number(ing.stock_quantity).toLocaleString(undefined, { maximumFractionDigits: 3 })} {ing.unit}
                                </span>
                              </td>
                              <td className="px-4 py-2.5 text-right tabular-nums text-zinc-300">{fmtValue(totalValue)}</td>
                              <td className="px-4 py-2.5 text-xs text-zinc-600 text-right">editing</td>
                            </tr>
                          );
                        }
                        return (
                          <tr key={ing.id} className={`border-b border-zinc-800/60 ${i % 2 !== 0 ? "bg-zinc-900/30" : ""}`}>
                            <td className="px-3 py-2.5 text-zinc-100 font-medium truncate">{ing.name}</td>
                            <td className="px-3 py-2.5 text-zinc-400 truncate">{ing.suppliers?.company_name ?? "—"}</td>
                            <td className="px-3 py-2.5 text-zinc-400 truncate">{ing.contract_brewing_partners?.company_name ?? "—"}</td>
                            <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap text-zinc-400">
                              {showAlphaAcid
                                ? (ing.alpha_acid != null ? `${ing.alpha_acid}%` : "—")
                                : showColorLovibond
                                  ? (ing.color_lovibond != null ? `${ing.color_lovibond}°L` : "—")
                                  : ""}
                            </td>
                            <td className="px-3 py-2.5 text-zinc-400 whitespace-nowrap">{ing.unit}</td>
                            <td className="px-3 py-2.5 text-zinc-300 text-right tabular-nums whitespace-nowrap">
                              {ing.cost_per_unit != null ? fmtUsd(Number(ing.cost_per_unit)) : "—"}
                            </td>
                            <td className="px-3 py-2.5 text-right tabular-nums whitespace-nowrap">
                              <span className={Number(ing.stock_quantity) < 0 ? "text-red-400" : "text-zinc-300"}>
                                {Number(ing.stock_quantity).toLocaleString(undefined, { maximumFractionDigits: 3 })} {ing.unit}
                              </span>
                            </td>
                            <td className="px-3 py-2.5 text-right tabular-nums text-zinc-300 whitespace-nowrap">{fmtValue(totalValue)}</td>
                            <td className="px-3 py-2.5">
                              <div className="flex gap-2 justify-end w-full">
                                <button onClick={() => openAdj(ing)} className="text-xs text-amber-500 hover:text-amber-400 transition-colors font-medium whitespace-nowrap">Adjust</button>
                                <span className="text-zinc-700">·</span>
                                <button onClick={() => openEdit(ing)} className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors whitespace-nowrap">Edit</button>
                                <span className="text-zinc-700">·</span>
                                <button onClick={() => handleDelete(ing.id, ing.name)} className="text-xs text-zinc-600 hover:text-red-400 transition-colors whitespace-nowrap">Del</button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
              );
            });
          })()}
        </div>
      )}

      {/* Bulk upload modal */}
      {showBulkModal && (
        <BulkUploadModal
          onClose={() => setShowBulkModal(false)}
          onDone={async () => { setShowBulkModal(false); await onRefresh(); }}
        />
      )}

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
            {ingForm.category === "Hops" && (
              <Field label="Alpha Acid (%)">
                <input type="number" step="0.1" min="0" className="inp" placeholder="e.g. 6.5"
                  value={ingForm.alpha_acid}
                  onChange={(e) => setIngForm((f) => ({ ...f, alpha_acid: e.target.value }))} />
              </Field>
            )}
            {ingForm.category === "Malts" && (
              <Field label="Color (°L — Lovibond)">
                <input type="number" step="0.1" min="0" className="inp" placeholder="e.g. 2.0"
                  value={ingForm.color_lovibond}
                  onChange={(e) => setIngForm((f) => ({ ...f, color_lovibond: e.target.value }))} />
              </Field>
            )}
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
                  {adjIngredient.cost_per_unit != null ? fmtUsd(Number(adjIngredient.cost_per_unit)) : "—"}
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

            {/* Purchase cost + shipping — only shown for "received" */}
            {adjType === "received" && (
              <>
                <Field label="Purchase Cost ($ per unit)">
                  <input type="number" step="0.01" min="0" className="inp" placeholder="0.00"
                    value={adjPurchaseCost} onChange={(e) => setAdjPurchaseCost(e.target.value)} />
                </Field>
                <Field label="Shipping Cost ($ total, optional)">
                  <input type="number" step="0.01" min="0" className="inp" placeholder="0.00"
                    value={adjShippingCost} onChange={(e) => setAdjShippingCost(e.target.value)} />
                </Field>
                {previewQty > 0 && previewCost > 0 && (
                  <div className="p-2.5 rounded bg-zinc-800/60 border border-zinc-700 text-xs space-y-1">
                    <p className="text-zinc-400 font-medium mb-1">After this receipt:</p>
                    <div className="flex justify-between">
                      <span className="text-zinc-500">Unit cost</span>
                      <span className="text-zinc-200">
                        {currentCost != null ? fmtUsd(Number(currentCost)) : "—"}
                        {" → "}
                        <span className="text-green-300">{fmtUsd(Number(newCostPerUnit))}</span>
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
                    {adjShippingCost !== "" && parseFloat(adjShippingCost) > 0 && (
                      <div className="flex justify-between">
                        <span className="text-zinc-500">Shipping</span>
                        <span className="text-zinc-400">+{fmtValue(parseFloat(adjShippingCost))}</span>
                      </div>
                    )}
                  </div>
                )}
              </>
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
