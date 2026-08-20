"use client";

import { useState, useMemo, useEffect, Fragment } from "react";
import { useSearchParams } from "next/navigation";
import { formatCurrency } from "@/lib/format";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { Recipe, RecipeBrewActivityTemplate, INGREDIENT_CATEGORIES, IngredientCategory, leadTimeDays, RecipePackagingVariation } from "../types";
import { Modal, Field, ModalActions } from "./shared";
import { EQ } from "../equipmentMeta";
import { useRecipesQuery, useIngredientsQuery, useContractPartnersQuery, productionKeys, fetchJson, usePackagingVariationsQuery, useRecipePackagingVariationsQuery } from "../hooks/queries";
import { useTableControls } from "@/app/components/ui/useTableControls";
import SearchInput from "@/app/components/ui/SearchInput";
import FilterChips from "@/app/components/ui/FilterChips";
import FilterBar from "@/app/components/ui/FilterBar";
import RecipeVariationPicker from "./RecipeVariationPicker";
import ProductCodeInput from "./ProductCodeInput";
import type { ControlsConfig } from "@/lib/table/types";

interface BrewStepTemplateData {
  id: string;
  name: string;
  steps: {
    sort_order: number;
    activity: string;
    time_label: string | null;
    temp: number | null;
    amount: number | null;
    vsp: number | null;
  }[];
}

interface RecipeFormLine {
  ingredient_id: string;
  quantity_per_turn: string;
  category: IngredientCategory | "";
}

interface ActivityFormLine {
  id?: string;
  activity: string;
  time_label: string;
  temp: string;
  amount: string;
  vsp: string;
}

const RECIPE_EMPTY = { beer_name: "", style: "", abv: "", ibu: "", partner_id: "", expected_yield_bbl: "", days_brewhouse: "", days_fermenter: "", days_brite: "", notes: "" };

const STAGE_BADGES: Record<"brewhouse" | "fermenter" | "brite", { label: string; badge: string }> = {
  brewhouse: { label: EQ.brewhouse.label, badge: EQ.brewhouse.badge },
  fermenter:  { label: EQ.fermenter.label,  badge: EQ.fermenter.badge },
  brite:      { label: "Brite Tank",        badge: EQ.brite.badge },
};

/** Total ingredient cost for one brew turn at the recipe's expected yield. Pure. */
function recipeCostPerTurn(r: Recipe): number {
  return r.recipe_ingredients.reduce(
    (sum, ri) => sum + ri.quantity_per_turn * (ri.ingredients.cost_per_unit_usd ?? 0),
    0,
  );
}

const PARTNER_HOUSE = "House brew";

/** Sort key for a never-measured abv/ibu: unknown sorts after every real
 * number, so an ascending sort reads "weakest first, then the unmeasured".
 * Finite on purpose — the comparator subtracts, and Infinity - Infinity is
 * NaN, which would make two unmeasured recipes compare as neither. */
const UNMEASURED = Number.MAX_SAFE_INTEGER;

const RECIPE_CONTROLS: ControlsConfig<Recipe> = {
  search: [{ param: "q", accessor: (r) => [r.beer_name, r.style, r.partner?.company_name] }],
  filters: [{ param: "partner", accessor: (r) => r.partner?.company_name ?? PARTNER_HOUSE }],
  sort: {
    columns: [
      { key: "name",        accessor: (r) => r.beer_name },
      { key: "style",       accessor: (r) => r.style ?? "" },
      { key: "abv",         accessor: (r) => r.abv ?? UNMEASURED },
      { key: "ibu",         accessor: (r) => r.ibu ?? UNMEASURED },
      { key: "cost",        accessor: (r) => recipeCostPerTurn(r) },
      { key: "lead",        accessor: (r) => leadTimeDays(r) },
      { key: "ingredients", accessor: (r) => r.recipe_ingredients.length },
    ],
    default: { key: "name", dir: "asc" },
  },
};

function templateToFormLine(t: RecipeBrewActivityTemplate): ActivityFormLine {
  return {
    id: t.id,
    activity: t.activity,
    time_label: t.time_label ?? "",
    temp: t.temp != null ? String(t.temp) : "",
    amount: t.amount != null ? String(t.amount) : "",
    vsp: (t as RecipeBrewActivityTemplate & { vsp?: number | null }).vsp != null
      ? String((t as RecipeBrewActivityTemplate & { vsp?: number | null }).vsp)
      : "",
  };
}

export default function RecipesTab() {
  const qc = useQueryClient();
  const { data: recipes = [] } = useRecipesQuery();
  const { data: ingredients = [] } = useIngredientsQuery();
  const { data: partners = [] } = useContractPartnersQuery();
  const { data: variations = [] } = usePackagingVariationsQuery();
  const { data: recipeLinks = [] } = useRecipePackagingVariationsQuery();
  const [managingFor, setManagingFor] = useState<string | null>(null);

  function variationsFor(recipeId: string): RecipePackagingVariation[] {
    return recipeLinks.filter((l) => l.recipe_id === recipeId);
  }

  async function unlinkVariation(linkId: string) {
    await fetch(`/api/production/recipe-packaging-variations?id=${linkId}`, { method: "DELETE" });
    await qc.invalidateQueries({ queryKey: productionKeys.recipePackagingVariations });
  }
  const { data: stepTemplates = [] } = useQuery({
    queryKey: queryKeys.production.brewStepTemplates(),
    queryFn: () => fetchJson<BrewStepTemplateData[]>("/api/production/brew-step-templates"),
    staleTime: 5 * 60 * 1000,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: productionKeys.recipes });

  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState(RECIPE_EMPTY);
  const [lines, setLines] = useState<RecipeFormLine[]>([]);
  const [activityLines, setActivityLines] = useState<ActivityFormLine[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // `?recipe=<id>` opens that recipe straight away — Brand → Releases links
  // here to edit the liquid a release pours. Read once on mount and never
  // written back on toggle, following the gl-mapping `?tab=` precedent.
  const searchParams = useSearchParams();
  const deepLinkedId = searchParams.get("recipe");
  const [expanded, setExpanded] = useState<string | null>(deepLinkedId);


  function openNew() {
    setForm(RECIPE_EMPTY);
    setLines([]);
    setActivityLines([]);
    setEditingId(null);
    setShowModal(true);
  }

  function openEdit(r: Recipe) {
    setForm({
      beer_name: r.beer_name,
      style: r.style ?? "",
      abv: r.abv != null ? String(r.abv) : "",
      ibu: r.ibu != null ? String(r.ibu) : "",
      partner_id: r.partner_id ?? "",
      expected_yield_bbl: r.expected_yield_bbl != null ? String(r.expected_yield_bbl) : "",
      days_brewhouse: r.days_brewhouse != null ? String(r.days_brewhouse) : "",
      days_fermenter: r.days_fermenter != null ? String(r.days_fermenter) : "",
      days_brite: r.days_brite != null ? String(r.days_brite) : "",
      notes: r.notes ?? "",
    });
    setLines(
      r.recipe_ingredients.map((ri) => ({
        ingredient_id: ri.ingredient_id,
        quantity_per_turn: String(ri.quantity_per_turn),
        category: (ri.ingredients.category as IngredientCategory) ?? "",
      }))
    );
    setActivityLines(
      [...(r.recipe_brew_activity_templates ?? [])].sort((a, b) => a.sort_order - b.sort_order).map(templateToFormLine)
    );
    setEditingId(r.id);
    setShowModal(true);
  }

  function openClone(r: Recipe) {
    // Pre-fill the create form from an existing recipe (primary use: conversion
    // recipes = base recipe + extra ingredients). editingId stays null so the
    // normal create path runs, minting a brand-new recipe. Name is left blank to
    // force a fresh, non-duplicate name.
    setForm({
      beer_name: "",
      style: r.style ?? "",
      abv: r.abv != null ? String(r.abv) : "",
      ibu: r.ibu != null ? String(r.ibu) : "",
      partner_id: r.partner_id ?? "",
      expected_yield_bbl: r.expected_yield_bbl != null ? String(r.expected_yield_bbl) : "",
      days_brewhouse: r.days_brewhouse != null ? String(r.days_brewhouse) : "",
      days_fermenter: r.days_fermenter != null ? String(r.days_fermenter) : "",
      days_brite: r.days_brite != null ? String(r.days_brite) : "",
      notes: r.notes ?? "",
    });
    setLines(
      r.recipe_ingredients.map((ri) => ({
        ingredient_id: ri.ingredient_id,
        quantity_per_turn: String(ri.quantity_per_turn),
        category: (ri.ingredients.category as IngredientCategory) ?? "",
      }))
    );
    setActivityLines(
      [...(r.recipe_brew_activity_templates ?? [])].sort((a, b) => a.sort_order - b.sort_order).map(templateToFormLine)
    );
    setEditingId(null);
    setShowModal(true);
  }

  function addIngredientLine() {
    setLines((l) => [...l, { ingredient_id: "", quantity_per_turn: "", category: "" }]);
  }

  function removeIngredientLine(i: number) {
    setLines((l) => l.filter((_, idx) => idx !== i));
  }

  function addActivityLine() {
    setActivityLines((l) => [...l, { activity: "", time_label: "", temp: "", amount: "", vsp: "" }]);
  }

  function loadFromTemplate(templateId: string) {
    const tpl = stepTemplates.find((t) => t.id === templateId);
    if (!tpl) return;
    setActivityLines(
      [...tpl.steps].sort((a, b) => a.sort_order - b.sort_order).map((s) => ({
        activity:   s.activity,
        time_label: s.time_label ?? "",
        temp:       s.temp != null   ? String(s.temp)   : "",
        amount:     s.amount != null ? String(s.amount) : "",
        vsp:        s.vsp != null    ? String(s.vsp)    : "",
      }))
    );
  }

  function removeActivityLine(i: number) {
    setActivityLines((l) => l.filter((_, idx) => idx !== i));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const payload = {
        beer_name: form.beer_name,
        style: form.style || null,
        abv: form.abv ? parseFloat(form.abv) : null,
        ibu: form.ibu ? parseInt(form.ibu, 10) : null,
        partner_id: form.partner_id || null,
        expected_yield_bbl: form.expected_yield_bbl ? parseFloat(form.expected_yield_bbl) : null,
        days_brewhouse: form.days_brewhouse ? parseInt(form.days_brewhouse) : null,
        days_fermenter: form.days_fermenter ? parseInt(form.days_fermenter) : null,
        days_brite: form.days_brite ? parseInt(form.days_brite) : null,
        notes: form.notes || null,
        ingredients: lines
          .filter((l) => l.ingredient_id && l.quantity_per_turn)
          .map((l) => ({
            ingredient_id: l.ingredient_id,
            quantity_per_turn: parseFloat(l.quantity_per_turn.replace(/,/g, "")),
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
      const saved = await res.json();

      // Sync activity templates: delete all existing, re-insert
      if (editingId) {
        const existingIds = (recipes.find((r) => r.id === editingId)?.recipe_brew_activity_templates ?? []).map((t) => t.id);
        for (const tid of existingIds) {
          await fetch(`/api/production/brew-activities?id=${tid}`, { method: "DELETE" });
        }
      }
      for (let i = 0; i < activityLines.length; i++) {
        const al = activityLines[i];
        if (!al.activity.trim()) continue;
        await fetch("/api/production/brew-activities", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            recipe_id: saved.id,
            sort_order: i,
            activity: al.activity,
            time_label: al.time_label || null,
            temp: al.temp !== "" ? parseFloat(al.temp) : null,
            amount: al.amount !== "" ? parseFloat(al.amount) : null,
            vsp: al.vsp !== "" ? parseFloat(al.vsp) : null,
          }),
        });
      }

      setShowModal(false);
      await refresh();
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
    await refresh();
  }

  // Search + partner filter + sort (URL-synced). Card list → sort is a
  // single-select chip group, mirroring Export Bay's documented one-off.
  const { rows: visibleRecipes, search, filters, sort, setSearch, setFilter, setSort, reset, activeCount } =
    useTableControls(recipes, RECIPE_CONTROLS, { prefix: "rec_" });

  // Bring a deep-linked recipe into view once its row has rendered. `center`,
  // not `start`: the page wears a StickyHeader, which would sit on top of a
  // row scrolled flush to the viewport top.
  const deepLinkedRendered = Boolean(deepLinkedId && visibleRecipes.some((r) => r.id === deepLinkedId));
  useEffect(() => {
    if (!deepLinkedRendered || !deepLinkedId) return;
    document.getElementById(`recipe-${deepLinkedId}`)?.scrollIntoView({ block: "center" });
  }, [deepLinkedRendered, deepLinkedId]);

  const partnerOptions = useMemo(() => {
    const names = new Set<string>();
    let hasHouse = false;
    for (const r of recipes) {
      if (r.partner?.company_name) names.add(r.partner.company_name);
      else hasHouse = true;
    }
    const opts = [...names].sort((a, b) => a.localeCompare(b)).map((n) => ({ value: n, label: n }));
    if (hasHouse) opts.push({ value: PARTNER_HOUSE, label: PARTNER_HOUSE });
    return opts;
  }, [recipes]);

  return (
    <>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-muted">Define beer recipes with ingredient bills and brew steps</p>
        <button onClick={openNew} className="btn-primary">+ New Recipe</button>
      </div>

      {recipes.length > 0 && (
        <FilterBar activeCount={activeCount} onClear={reset} className="mb-4">
          <SearchInput
            value={search.q ?? ""}
            onChange={(v) => setSearch("q", v)}
            placeholder="Search recipes…"
          />
          {partnerOptions.length > 1 && (
            <FilterChips
              label="Partner"
              options={partnerOptions}
              value={filters.partner ?? []}
              onChange={(v) => setFilter("partner", v)}
            />
          )}
          {/* Card list, not a column table → sort is a single-select chip group. */}
          <FilterChips
            label="Sort"
            options={[
              { value: "name",        label: "A–Z"         },
              { value: "style",       label: "Style"       },
              { value: "abv",         label: "ABV"         },
              { value: "ibu",         label: "IBU"         },
              { value: "cost",        label: "Cost"        },
              { value: "lead",        label: "Lead time"   },
              { value: "ingredients", label: "Ingredients" },
            ]}
            value={sort ? [sort.key] : ["name"]}
            onChange={(v) => setSort(v[0] ?? "name", "asc")}
          />
        </FilterBar>
      )}

      {recipes.length === 0 ? (
        <p className="text-faint text-sm">No recipes yet.</p>
      ) : visibleRecipes.length === 0 ? (
        <p className="text-faint text-sm">No recipes match the current filters.</p>
      ) : (
        <div className="space-y-2">
          {visibleRecipes.map((r) => {
            const isOpen = expanded === r.id;
            const costPerTurn = recipeCostPerTurn(r);
            const costPerBblYield = r.expected_yield_bbl ? costPerTurn / r.expected_yield_bbl : null;
            const hasIdentity = Boolean((r.style && r.style !== r.beer_name) || r.abv != null || r.ibu != null || r.partner?.company_name);
            const hasSchedule = Boolean(r.expected_yield_bbl || leadTimeDays(r) > 0 || r.days_brewhouse != null || r.days_fermenter != null || r.days_brite != null);

            return (
              <div key={r.id} id={`recipe-${r.id}`} className="rounded-lg border border-line overflow-hidden">
                {/* Header row */}
                <button
                  type="button"
                  className="px-4 py-3 w-full text-left cursor-pointer hover:bg-surface/40 transition-colors"
                  onClick={() => setExpanded(isOpen ? null : r.id)}
                >
                  {/* Name + chevron row */}
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="text-sm font-medium text-primary">{r.beer_name}</span>
                    <span className="text-faint text-xs shrink-0">{isOpen ? "▲" : "▼"}</span>
                  </div>
                  {/* Metadata row — three bands (identity · schedule · money) so the
                   * row has a reading order instead of one flat wrap. Each band is
                   * its own flex box, and bands 2 and 3 carry the separator so a
                   * band that has nothing to show takes its divider with it. */}
                  <div className="flex items-center gap-x-6 gap-y-1.5 flex-wrap">
                    {hasIdentity && (
                      <div className="flex items-center gap-x-2.5 gap-y-1 flex-wrap">
                        {r.style && r.style !== r.beer_name && (
                          <span className="text-xs text-secondary">{r.style}</span>
                        )}
                        {r.abv != null && (
                          <span className="text-xs text-muted tabular-nums">{r.abv}% ABV</span>
                        )}
                        {r.ibu != null && (
                          <span className="text-xs text-muted tabular-nums">{r.ibu} IBU</span>
                        )}
                        {r.partner?.company_name && (
                          <span className="text-xs text-muted bg-surface-mid px-2 py-0.5 rounded">
                            {r.partner.company_name}
                          </span>
                        )}
                      </div>
                    )}
                    {hasSchedule && (
                      <div className="flex items-center gap-x-2.5 gap-y-1 flex-wrap">
                        {r.expected_yield_bbl && (
                          <span className="text-xs text-muted tabular-nums">
                            {r.expected_yield_bbl.toLocaleString()} BBL / turn
                          </span>
                        )}
                        {leadTimeDays(r) > 0 && (
                          <span className="text-xs text-muted tabular-nums">{leadTimeDays(r)}d lead</span>
                        )}
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
                      </div>
                    )}
                    <div className="flex items-center gap-x-2.5 gap-y-1 flex-wrap">
                      {costPerTurn > 0 && (
                        <span className="text-xs font-medium text-body tabular-nums">
                          {formatCurrency(costPerTurn)}/turn
                        </span>
                      )}
                      {costPerBblYield != null && costPerTurn > 0 && (
                        <span className="text-xs text-muted tabular-nums">
                          {formatCurrency(costPerBblYield)}/BBL
                        </span>
                      )}
                      <span className="text-xs text-faint">
                        {r.recipe_ingredients.length} ingredient{r.recipe_ingredients.length !== 1 ? "s" : ""}
                      </span>
                    </div>
                  </div>
                </button>

                {/* Expanded detail */}
                {isOpen && (
                  <div className="border-t border-line">
                    {/* Actions ride at the top of the panel: on a long recipe the bottom
                      * of the card sits two screens from the name it belongs to. Delete is
                      * pushed to the far edge so it is not a slip away from Clone. */}
                    <div className="flex items-center gap-3 px-4 py-2.5 border-b border-line bg-surface/30">
                      <button onClick={() => openEdit(r)} className="btn-secondary">Edit recipe</button>
                      <button onClick={() => openClone(r)} className="btn-secondary">Clone</button>
                      <button onClick={() => setManagingFor(r.id)} className="btn-secondary">Manage variations</button>
                      <button onClick={() => handleDelete(r.id, r.beer_name)} className="btn-danger ml-auto">Delete</button>
                    </div>

                    {/* Two columns from lg up: what the beer is made of on the left, how
                      * it is scheduled and packaged on the right. The old layout stacked
                      * six full-width bands and ran past two viewport heights. */}
                    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] items-start lg:items-stretch">
                      <div className="min-w-0">
                      {/* Ingredient bill — the same section shape as Brew Steps and
                        * Packaging Variations: uppercase label, then a bordered table.
                        * It used to be a bare flush table sitting beside two bordered
                        * cards, which read as two different kinds of thing. */}
                      <div className="px-4 py-3">
                        <p className="text-xs font-medium text-muted uppercase tracking-wider mb-2">Ingredient Bill</p>
                      {r.recipe_ingredients.length > 0 ? (() => {
                        const grouped: Record<string, typeof r.recipe_ingredients> = {};
                        for (const ri of r.recipe_ingredients) {
                          const cat = ri.ingredients.category ?? "Uncategorized";
                          if (!grouped[cat]) grouped[cat] = [];
                          grouped[cat].push(ri);
                        }
                        // Read the bill the way it is brewed: malts, hops, yeast,
                        // then everything else. INGREDIENT_CATEGORIES already
                        // carries that order; anything off that list sorts last.
                        const catRank = (c: string) => {
                          const i = INGREDIENT_CATEGORIES.indexOf(c as IngredientCategory);
                          return i === -1 ? INGREDIENT_CATEGORIES.length : i;
                        };
                        const groups = Object.entries(grouped)
                          .sort(([a], [b]) => catRank(a) - catRank(b) || a.localeCompare(b))
                          .map(([cat, items]) => [
                            cat,
                            [...items].sort((x, y) => x.ingredients.name.localeCompare(y.ingredients.name)),
                          ] as const);
                        return (
                          <div className="overflow-x-auto rounded-lg border border-line">
                          <table className="w-full text-sm min-w-[360px]">
                            <thead>
                              <tr className="border-b border-line bg-surface/50 text-left">
                                <th className="px-3 py-2 text-xs font-medium text-muted">Ingredient</th>
                                <th className="px-3 py-2 text-xs font-medium text-muted text-right whitespace-nowrap">Cost / Unit</th>
                                <th className="px-3 py-2 text-xs font-medium text-muted text-right whitespace-nowrap">Qty / Turn</th>
                                <th className="px-3 py-2 text-xs font-medium text-muted text-right whitespace-nowrap">$ / Turn</th>
                              </tr>
                            </thead>
                            <tbody>
                              {groups.map(([cat, items]) => (
                                <Fragment key={cat}>
                                  <tr className="border-b border-line/40 bg-surface/60">
                                    <td colSpan={4} className="px-3 py-1 text-xs font-semibold text-muted uppercase tracking-wider">{cat}</td>
                                  </tr>
                                  {items.map((ri, idx) => {
                                    const ing = ri.ingredients;
                                    const qtyPerTurn = ri.quantity_per_turn;
                                    const costPerLine = qtyPerTurn * (ing.cost_per_unit_usd ?? 0);
                                    return (
                                      <tr key={ri.id} className={`border-b border-line/40 ${idx % 2 !== 0 ? "bg-surface/20" : ""}`}>
                                        <td className="px-3 py-2 text-strong pl-6">{ing.name}</td>
                                        <td className="px-3 py-2 text-muted text-right tabular-nums">
                                          {ing.cost_per_unit_usd != null
                                            ? `${formatCurrency(Number(ing.cost_per_unit_usd))} / ${ing.unit}`
                                            : "—"}
                                        </td>
                                        <td className="px-3 py-2 text-secondary text-right tabular-nums">
                                          {qtyPerTurn.toLocaleString(undefined, { maximumFractionDigits: 6 })} {ing.unit}
                                        </td>
                                        <td className="px-3 py-2 text-body text-right tabular-nums">
                                          {ing.cost_per_unit_usd != null
                                            ? formatCurrency(costPerLine)
                                            : "—"}
                                        </td>
                                      </tr>
                                    );
                                  })}
                                </Fragment>
                              ))}
                              {costPerTurn > 0 && (
                                <tr className="border-t border-line-strong bg-surface/50">
                                  <td className="px-3 py-2 text-xs font-medium text-secondary" colSpan={3}>Total cost / turn</td>
                                  <td className="px-3 py-2 text-right text-strong font-medium tabular-nums">
                                    {formatCurrency(costPerTurn)}
                                  </td>
                                </tr>
                              )}
                              {costPerBblYield != null && costPerTurn > 0 && (
                                <tr className="bg-surface/30">
                                  <td className="px-3 py-2 text-xs font-medium text-muted" colSpan={3}>Cost / BBL yield</td>
                                  <td className="px-3 py-2 text-right text-secondary tabular-nums text-xs">
                                    {formatCurrency(costPerBblYield)}
                                  </td>
                                </tr>
                              )}
                            </tbody>
                          </table>
                          </div>
                        );
                      })() : (
                        <p className="text-xs text-faint">No ingredients on this recipe.</p>
                      )}
                      </div>

                      {/* Brew Steps — always rendered, empty or not: a section that
                        * hides itself gives no hint the recipe can hold brew steps. */}
                      <div className="px-4 py-3 border-t border-line">
                        <p className="text-xs font-medium text-muted uppercase tracking-wider mb-2">Brew Steps</p>
                        {r.recipe_brew_activity_templates && r.recipe_brew_activity_templates.length > 0 ? (
                          <div className="overflow-x-auto rounded-lg border border-line">
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="border-b border-line bg-surface/50 text-left">
                                  <th className="px-3 py-2 font-medium text-muted">#</th>
                                  <th className="px-3 py-2 font-medium text-muted">Activity</th>
                                  <th className="px-3 py-2 font-medium text-muted text-right">Time (min)</th>
                                  <th className="px-3 py-2 font-medium text-muted text-right">Temp</th>
                                  <th className="px-3 py-2 font-medium text-muted text-right">Amount</th>
                                  <th className="px-3 py-2 font-medium text-muted text-right">VSP</th>
                                </tr>
                              </thead>
                              <tbody>
                                {[...r.recipe_brew_activity_templates].sort((a, b) => a.sort_order - b.sort_order).map((t, i) => {
                                  const tAny = t as RecipeBrewActivityTemplate & { vsp?: number | null };
                                  return (
                                  <tr key={t.id} className={`border-b border-line/40 ${i % 2 !== 0 ? "bg-surface/20" : ""}`}>
                                    <td className="px-3 py-2 text-faint tabular-nums">{i + 1}</td>
                                    <td className="px-3 py-2 text-body">{t.activity}</td>
                                    <td className="px-3 py-2 text-muted text-right tabular-nums">{t.time_label ?? "—"}</td>
                                    <td className="px-3 py-2 text-muted text-right tabular-nums">{t.temp != null ? `${t.temp}°F` : "—"}</td>
                                    <td className="px-3 py-2 text-muted text-right tabular-nums">{t.amount != null ? t.amount.toLocaleString() : "—"}</td>
                                    <td className="px-3 py-2 text-muted text-right tabular-nums">{tAny.vsp != null ? tAny.vsp : "—"}</td>
                                  </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        ) : (
                          <p className="text-xs text-faint">No brew steps on this recipe — add them under <span className="text-muted">Edit recipe</span>.</p>
                        )}
                      </div>
                      </div>
                      <div className="min-w-0 border-t border-line lg:border-t-0 lg:border-l lg:border-line">
                        {/* Schedule — yield, lead, and the stage clock. The header chips
                          * summarise these; this is where they get a labelled home. */}
                        <div className="px-4 py-3">
                          <p className="text-xs font-medium text-muted uppercase tracking-wider mb-2">Schedule</p>
                          {hasSchedule ? (<>
                            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 mb-2">
                              {r.expected_yield_bbl && (
                                <span className="text-sm text-body tabular-nums">
                                  {r.expected_yield_bbl.toLocaleString()} <span className="text-xs text-muted">BBL / turn</span>
                                </span>
                              )}
                              {leadTimeDays(r) > 0 && (
                                <span className="text-sm text-body tabular-nums">
                                  {leadTimeDays(r)} <span className="text-xs text-muted">days lead</span>
                                </span>
                              )}
                            </div>
                            {(r.days_brewhouse != null || r.days_fermenter != null || r.days_brite != null) && (
                              <div className="flex flex-col gap-1">
                                {(["brewhouse", "fermenter", "brite"] as const).map((stage) => {
                                  const val = stage === "brewhouse" ? r.days_brewhouse : stage === "fermenter" ? r.days_fermenter : r.days_brite;
                                  if (val == null) return null;
                                  return (
                                    <div key={stage} className="flex items-center gap-2">
                                      <span className={`text-xs px-1.5 py-px rounded border w-24 text-center ${STAGE_BADGES[stage].badge}`}>
                                        {STAGE_BADGES[stage].label}
                                      </span>
                                      <span className="text-sm text-body tabular-nums">{val} {val === 1 ? "day" : "days"}</span>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </>) : (
                            <p className="text-xs text-faint">No schedule set on this recipe — add it under <span className="text-muted">Edit recipe</span>.</p>
                          )}
                        </div>

                        {/* Notes — a human wrote this about the recipe, so it reads at body
                          * size near the top of the rail, not as faint italic in the basement. */}
                        <div className="px-4 py-3 border-t border-line">
                          <p className="text-xs font-medium text-muted uppercase tracking-wider mb-2">Notes</p>
                          {r.notes
                            ? <p className="text-sm text-secondary whitespace-pre-line">{r.notes}</p>
                            : <p className="text-xs text-faint">No notes on this recipe — add them under <span className="text-muted">Edit recipe</span>.</p>}
                        </div>

                      {/* Packaging Variations — a container and its product code
                       * are one fact, so they read as an aligned two-column list
                       * rather than a chip with an input trailing off its side. */}
                      {(() => {
                        const links = [...variationsFor(r.id)].sort((a, b) =>
                          (a.packaging_variations?.name ?? "").localeCompare(b.packaging_variations?.name ?? ""),
                        );
                        return (
                      <div className="px-4 py-3 border-t border-line">
                        <div className="flex items-baseline justify-between gap-3 mb-2">
                          <p className="text-xs font-medium text-muted uppercase tracking-wider">Packaging Variations</p>
                          {links.length > 0 && (
                            <span className="text-xs text-faint tabular-nums">
                              {links.filter((l) => l.product_code).length} of {links.length} coded
                            </span>
                          )}
                        </div>

                        {links.length > 0 ? (
                          <div className="rounded-lg border border-line overflow-hidden">
                            <div className="flex items-center gap-3 px-3 py-2 bg-surface/50 border-b border-line">
                              <span className="flex-1 text-xs font-medium text-muted">Container</span>
                              <span className="w-32 text-xs font-medium text-muted">Product Code</span>
                              <span className="w-5" aria-hidden />
                            </div>
                            {links.map((link, idx) => (
                              <div
                                key={link.id}
                                className={`flex items-center gap-3 px-3 py-2 ${idx > 0 ? "border-t border-line/40" : ""} ${idx % 2 !== 0 ? "bg-surface/20" : ""}`}
                              >
                                {/* These names differ only in their tail — "…Labeled Can" vs
                                  * "…Labeled Can Case" — so truncating the end cuts exactly the
                                  * half that tells them apart. Wrap instead. */}
                                <span className="flex-1 text-sm text-body leading-snug break-words">
                                  {link.packaging_variations?.name ?? "—"}
                                </span>
                                <ProductCodeInput
                                  link={link}
                                  showLabel={false}
                                  onSaved={() => qc.invalidateQueries({ queryKey: productionKeys.recipePackagingVariations })}
                                />
                                <button
                                  onClick={() => unlinkVariation(link.id)}
                                  aria-label={`Unlink ${link.packaging_variations?.name ?? "variation"}`}
                                  title="Unlink"
                                  className="w-5 text-center text-faint hover:text-danger leading-none"
                                >
                                  ×
                                </button>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="text-xs text-faint">No packaging variations linked yet — use <span className="text-muted">Manage variations</span> above.</p>
                        )}
                      </div>
                        );
                      })()}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {managingFor && (() => {
        const r = recipes.find((rec) => rec.id === managingFor);
        if (!r) return null;
        return (
          <RecipeVariationPicker
            recipeName={r.beer_name}
            recipeId={r.id}
            variations={variations}
            currentLinks={variationsFor(r.id)}
            onClose={() => setManagingFor(null)}
            onSaved={() => qc.invalidateQueries({ queryKey: productionKeys.recipePackagingVariations })}
          />
        );
      })()}

      {showModal && (
        <Modal
          title={editingId ? "Edit Recipe" : "New Recipe"}
          onClose={() => setShowModal(false)}
          extraWide
        >
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Beer Style" hint="the plain style, as printed on the label">
                <input className="inp" placeholder="e.g. Jasmine Peach Lager" value={form.style}
                  onChange={(e) => setForm((f) => ({ ...f, style: e.target.value }))} />
              </Field>
              <Field label="ABV (%)">
                <input type="number" step="0.1" min="0" max="99.9" className="inp" placeholder="e.g. 5.2"
                  value={form.abv}
                  onChange={(e) => setForm((f) => ({ ...f, abv: e.target.value }))} />
              </Field>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="IBU" hint="bitterness, as a whole number">
                <input type="number" step="1" min="0" max="200" className="inp" placeholder="e.g. 45"
                  value={form.ibu}
                  onChange={(e) => setForm((f) => ({ ...f, ibu: e.target.value }))} />
              </Field>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Expected Yield / Turn (BBL)" hint="for a 20 BBL brewhouse">
                <input
                  type="number" step="0.01" min="0" className="inp" placeholder="e.g. 18.5"
                  value={form.expected_yield_bbl}
                  onChange={(e) => setForm((f) => ({ ...f, expected_yield_bbl: e.target.value }))}
                />
              </Field>
              <Field label="Lead Time">
                <div className="inp flex items-center gap-2 bg-surface/40 cursor-default select-none">
                  <span className="text-body tabular-nums font-medium">
                    {(parseInt(form.days_brewhouse) || 0) + (parseInt(form.days_fermenter) || 0) + (parseInt(form.days_brite) || 0)} days
                  </span>
                  <span className="text-xs text-faint">← auto-calc</span>
                </div>
              </Field>
            </div>

            <div>
              <p className="text-xs text-secondary mb-2">Stage Duration (days)</p>
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
                <div className="flex items-center gap-2">
                  <label className="text-xs text-secondary">Ingredient Bill</label>
                  <span className="text-xs text-faint">(qty per turn)</span>
                </div>
                <button type="button" onClick={addIngredientLine}
                  className="btn-secondary shrink-0">
                  + Add ingredient
                </button>
              </div>
              {ingredients.length === 0 && (
                <p className="text-xs text-faint mt-1">Add ingredients in the Ingredients tab first.</p>
              )}
              {lines.length > 0 && (
                <div className="space-y-2 sm:space-y-0">
                  {/* Mobile: stacked card layout */}
                  <div className="sm:hidden space-y-2">
                    {lines.map((line, i) => {
                      const filteredIngs = line.category
                        ? ingredients.filter((ing) => ing.category === line.category)
                        : [];
                      const ing = ingredients.find((ing) => ing.id === line.ingredient_id);
                      const costPerTurnLine =
                        ing?.cost_per_unit_usd != null && line.quantity_per_turn
                          ? ing.cost_per_unit_usd * parseFloat(line.quantity_per_turn.replace(/,/g, ""))
                          : null;
                      return (
                        <div key={i} className="rounded border border-line p-3 space-y-2">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs text-muted font-medium">Ingredient {i + 1}</span>
                            <button type="button" onClick={() => removeIngredientLine(i)}
                              className="btn-danger btn-xxs">× Remove</button>
                          </div>
                          <div>
                            <label className="text-xs text-muted mb-1 block">Category</label>
                            <select className="inp-sm" value={line.category}
                              onChange={(e) => setLines((ls) => ls.map((l, idx) => idx === i
                                ? { ...l, category: e.target.value as IngredientCategory | "", ingredient_id: "" }
                                : l))}>
                              <option value="">— select —</option>
                              {INGREDIENT_CATEGORIES.map((cat) => (
                                <option key={cat} value={cat}>{cat}</option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label className="text-xs text-muted mb-1 block">Ingredient</label>
                            <select className="inp" value={line.ingredient_id} disabled={!line.category}
                              onChange={(e) => setLines((ls) => ls.map((l, idx) => idx === i ? { ...l, ingredient_id: e.target.value } : l))}>
                              <option value="">{line.category ? "— select —" : "— pick category first —"}</option>
                              {filteredIngs.map((ing) => (
                                <option key={ing.id} value={ing.id}>{ing.name}</option>
                              ))}
                            </select>
                          </div>
                          <div className="flex gap-2 items-end">
                            <div className="flex-1">
                              <label className="text-xs text-muted mb-1 block">Qty / Turn</label>
                              <input
                                type="text" inputMode="decimal" placeholder="qty/turn"
                                className="inp text-right w-full"
                                value={line.quantity_per_turn}
                                onChange={(e) => {
                                  const raw = e.target.value.replace(/,/g, "");
                                  setLines((ls) => ls.map((l, idx) => idx === i ? { ...l, quantity_per_turn: raw } : l));
                                }}
                                onBlur={(e) => {
                                  const num = parseFloat(e.target.value.replace(/,/g, ""));
                                  if (!isNaN(num)) {
                                    setLines((ls) => ls.map((l, idx) => idx === i ? { ...l, quantity_per_turn: num.toLocaleString(undefined, { maximumFractionDigits: 20 }) } : l));
                                  }
                                }}
                                onFocus={(e) => {
                                  const raw = e.target.value.replace(/,/g, "");
                                  setLines((ls) => ls.map((l, idx) => idx === i ? { ...l, quantity_per_turn: raw } : l));
                                }}
                              />
                            </div>
                            {costPerTurnLine != null && (
                              <div className="text-right shrink-0 pb-1.5">
                                <span className="text-xs text-muted">$ / turn</span>
                                <p className="text-sm text-body tabular-nums">
                                  {formatCurrency(costPerTurnLine)}
                                </p>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {/* Desktop: table layout */}
                  <div className="hidden sm:block rounded border border-line overflow-x-auto">
                  <table className="w-full text-sm min-w-[520px]">
                    <thead>
                      <tr className="border-b border-line bg-surface/50">
                        <th className="px-3 py-2 text-xs font-medium text-muted text-left">Category</th>
                        <th className="px-3 py-2 text-xs font-medium text-muted text-left">Ingredient</th>
                        <th className="px-3 py-2 text-xs font-medium text-muted text-right">Cost / Unit</th>
                        <th className="px-3 py-2 text-xs font-medium text-muted text-right">Qty / Turn</th>
                        <th className="px-3 py-2 text-xs font-medium text-muted text-right">$ / Turn</th>
                        <th className="px-3 py-2 w-6"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {lines.map((line, i) => {
                        const filteredIngs = line.category
                          ? ingredients.filter((ing) => ing.category === line.category)
                          : [];
                        const ing = ingredients.find((ing) => ing.id === line.ingredient_id);
                        const costPerTurnLine =
                          ing?.cost_per_unit_usd != null && line.quantity_per_turn
                            ? ing.cost_per_unit_usd * parseFloat(line.quantity_per_turn.replace(/,/g, ""))
                            : null;
                        return (
                          <tr key={i} className={`border-b border-line/60 ${i % 2 !== 0 ? "bg-surface/20" : ""}`}>
                            <td className="px-3 py-1.5">
                              <select className="inp-sm" value={line.category}
                                onChange={(e) => setLines((ls) => ls.map((l, idx) => idx === i
                                  ? { ...l, category: e.target.value as IngredientCategory | "", ingredient_id: "" }
                                  : l))}>
                                <option value="">— select —</option>
                                {INGREDIENT_CATEGORIES.map((cat) => (
                                  <option key={cat} value={cat}>{cat}</option>
                                ))}
                              </select>
                            </td>
                            <td className="px-3 py-1.5 w-64">
                              <select className="inp-sm w-full" value={line.ingredient_id} disabled={!line.category}
                                onChange={(e) => setLines((ls) => ls.map((l, idx) => idx === i ? { ...l, ingredient_id: e.target.value } : l))}>
                                <option value="">{line.category ? "— select —" : "— pick category first —"}</option>
                                {filteredIngs.map((ing) => (
                                  <option key={ing.id} value={ing.id}>{ing.name}</option>
                                ))}
                              </select>
                            </td>
                            <td className="px-3 py-1.5 text-right text-xs text-muted tabular-nums whitespace-nowrap">
                              {ing?.cost_per_unit_usd != null
                                ? `${formatCurrency(Number(ing.cost_per_unit_usd))} / ${ing.unit}`
                                : "—"}
                            </td>
                            <td className="px-3 py-1.5 w-32">
                              <input
                                type="text"
                                inputMode="decimal"
                                placeholder="qty/turn"
                                className="inp-sm text-right w-full"
                                value={line.quantity_per_turn}
                                onChange={(e) => {
                                  const raw = e.target.value.replace(/,/g, "");
                                  setLines((ls) => ls.map((l, idx) => idx === i ? { ...l, quantity_per_turn: raw } : l));
                                }}
                                onBlur={(e) => {
                                  const num = parseFloat(e.target.value.replace(/,/g, ""));
                                  if (!isNaN(num)) {
                                    setLines((ls) => ls.map((l, idx) => idx === i ? { ...l, quantity_per_turn: num.toLocaleString(undefined, { maximumFractionDigits: 20 }) } : l));
                                  }
                                }}
                                onFocus={(e) => {
                                  const raw = e.target.value.replace(/,/g, "");
                                  setLines((ls) => ls.map((l, idx) => idx === i ? { ...l, quantity_per_turn: raw } : l));
                                }}
                              />
                            </td>
                            <td className="px-3 py-1.5 text-right text-xs tabular-nums whitespace-nowrap">
                              {costPerTurnLine != null
                                ? <span className="text-body">{formatCurrency(costPerTurnLine)}</span>
                                : <span className="text-faint">—</span>}
                            </td>
                            <td className="px-3 py-1.5 text-center">
                              <button type="button" onClick={() => removeIngredientLine(i)}
                                className="btn-danger btn-xxs">×</button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  </div>
                </div>
              )}
            </div>

            {/* Brew Steps */}
            <div>
              <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
                <label className="text-xs text-secondary">Brew Steps</label>
                <div className="flex items-center gap-2">
                  {stepTemplates.length > 0 && (
                    <select
                      value=""
                      onChange={(e) => { if (e.target.value) loadFromTemplate(e.target.value); }}
                      className="inp-sm"
                    >
                      <option value="">Load from template…</option>
                      {stepTemplates.map((t) => (
                        <option key={t.id} value={t.id}>{t.name}</option>
                      ))}
                    </select>
                  )}
                  <button type="button" onClick={addActivityLine}
                    className="btn-secondary">
                    + Add step
                  </button>
                </div>
              </div>
              <p className="text-xs text-faint mb-2">When a new batch is created from this recipe, these steps are copied into the batch&apos;s activity log.</p>
              {activityLines.length > 0 && (
                <div className="rounded border border-line overflow-x-auto">
                  <table className="w-full text-sm min-w-[480px]">
                    <thead>
                      <tr className="border-b border-line bg-surface/50">
                        <th className="px-3 py-2 text-xs font-medium text-muted text-left">Activity</th>
                        <th className="px-3 py-2 text-xs font-medium text-muted text-right w-20">Time (min)</th>
                        <th className="px-3 py-2 text-xs font-medium text-muted text-right w-20">Temp (°F)</th>
                        <th className="px-3 py-2 text-xs font-medium text-muted text-right w-20">Amount</th>
                        <th className="px-3 py-2 text-xs font-medium text-muted text-right w-20">VSP</th>
                        <th className="px-3 py-2 w-6"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {activityLines.map((al, i) => (
                        <tr key={i} className={`border-b border-line/60 ${i % 2 !== 0 ? "bg-surface/20" : ""}`}>
                          <td className="px-3 py-1.5">
                            <input className="inp-sm w-full" placeholder="e.g. Mash in" value={al.activity}
                              onChange={(e) => setActivityLines((ls) => ls.map((l, idx) => idx === i ? { ...l, activity: e.target.value } : l))} />
                          </td>
                          <td className="px-2 py-1.5 w-20">
                            <input type="number" step="1" className="inp-sm text-right w-full" placeholder="0" value={al.time_label}
                              onChange={(e) => setActivityLines((ls) => ls.map((l, idx) => idx === i ? { ...l, time_label: e.target.value } : l))} />
                          </td>
                          <td className="px-2 py-1.5 w-20">
                            <input type="number" step="0.1" className="inp-sm text-right w-full" placeholder="152" value={al.temp}
                              onChange={(e) => setActivityLines((ls) => ls.map((l, idx) => idx === i ? { ...l, temp: e.target.value } : l))} />
                          </td>
                          <td className="px-2 py-1.5 w-20">
                            <input type="number" step="0.01" className="inp-sm text-right w-full" placeholder="0" value={al.amount}
                              onChange={(e) => setActivityLines((ls) => ls.map((l, idx) => idx === i ? { ...l, amount: e.target.value } : l))} />
                          </td>
                          <td className="px-2 py-1.5 w-20">
                            <input type="number" step="0.1" className="inp-sm text-right w-full" placeholder="0" value={al.vsp}
                              onChange={(e) => setActivityLines((ls) => ls.map((l, idx) => idx === i ? { ...l, vsp: e.target.value } : l))} />
                          </td>
                          <td className="px-3 py-1.5 text-center">
                            <button type="button" onClick={() => removeActivityLine(i)}
                              className="btn-danger btn-xxs">×</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
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


