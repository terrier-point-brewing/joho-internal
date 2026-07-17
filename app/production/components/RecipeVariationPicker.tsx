"use client";

import { useMemo, useState } from "react";
import { PackagingVariation, RecipePackagingVariation } from "../types";
import { Modal } from "./shared";
import SearchInput from "@/app/components/ui/SearchInput";
import FilterChips from "@/app/components/ui/FilterChips";
import FilterBar from "@/app/components/ui/FilterBar";
import { KEG_TAG_BADGE } from "../lib/categoryColors";
import { applyControls } from "@/lib/table/applyControls";
import {
  FORMATS,
  PACKAGING_VARIATION_CONTROLS,
  PKGVAR_TYPE_OPTIONS,
  PKGVAR_FORMAT_OPTIONS,
  buildVariationPartnerOptions,
  sortVariationsForDisplay,
} from "@/lib/production/packagingVariations";

/**
 * Multi-select picker for linking packaging variations to a recipe. Reuses the
 * catalog's shared search/filter config (kegs collapse to "loose"; "generic" =
 * no partner) against local, ephemeral state — the modal never touches the URL.
 * Existing links come in pre-checked; Save diffs the checkbox set and fires the
 * add/remove requests in one batch.
 */
export default function RecipeVariationPicker({
  recipeName,
  recipeId,
  variations,
  currentLinks,
  onClose,
  onSaved,
}: {
  recipeName: string;
  recipeId: string;
  variations: PackagingVariation[];
  currentLinks: RecipePackagingVariation[];
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const linkedVariationIds = useMemo(
    () => new Set(currentLinks.map((l) => l.variation_id)),
    [currentLinks],
  );

  // Show active variations, plus any already-linked one even if it went inactive
  // (so it stays visible/checked rather than silently dropping off the list).
  const base = useMemo(
    () => variations.filter((v) => v.is_active || linkedVariationIds.has(v.id)),
    [variations, linkedVariationIds],
  );

  const [selected, setSelected] = useState<Set<string>>(() => new Set(linkedVariationIds));
  const [q, setQ] = useState("");
  const [typeF, setTypeF] = useState<string[]>([]);
  const [formatF, setFormatF] = useState<string[]>([]);
  const [partnerF, setPartnerF] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const partnerOptions = useMemo(() => buildVariationPartnerOptions(base), [base]);
  const activeCount = (q ? 1 : 0) + typeF.length + formatF.length + partnerF.length;

  function resetFilters() {
    setQ("");
    setTypeF([]);
    setFormatF([]);
    setPartnerF([]);
  }

  const filtered = useMemo(() => {
    const rows = applyControls(base, PACKAGING_VARIATION_CONTROLS, {
      search: { q },
      filters: { type: typeF, format: formatF, partner: partnerF },
      sort: null,
    });
    return sortVariationsForDisplay(rows);
  }, [base, q, typeF, formatF, partnerF]);

  const filteredIds = useMemo(() => filtered.map((v) => v.id), [filtered]);
  const allFilteredSelected = filteredIds.length > 0 && filteredIds.every((id) => selected.has(id));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllFiltered() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) filteredIds.forEach((id) => next.delete(id));
      else filteredIds.forEach((id) => next.add(id));
      return next;
    });
  }

  // Group the sorted rows by their display bucket (keg, or "Can · <Format>").
  const groups = useMemo(() => {
    const out: { key: string; label: string; items: PackagingVariation[] }[] = [];
    for (const v of filtered) {
      const isKeg = v.container?.type === "keg";
      const key = isKeg ? "keg" : `can:${v.format}`;
      const label = isKeg ? "Keg" : `Can · ${FORMATS.find((f) => f.value === v.format)?.label ?? v.format}`;
      const last = out[out.length - 1];
      if (last && last.key === key) last.items.push(v);
      else out.push({ key, label, items: [v] });
    }
    return out;
  }, [filtered]);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const currentByVar = new Map(currentLinks.map((l) => [l.variation_id, l.id]));
      const toAdd = [...selected].filter((id) => !currentByVar.has(id));
      const toRemove = currentLinks.filter((l) => !selected.has(l.variation_id));

      const results = await Promise.all([
        ...toAdd.map((variation_id) =>
          fetch("/api/production/recipe-packaging-variations", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ recipe_id: recipeId, variation_id }),
          }),
        ),
        ...toRemove.map((l) =>
          fetch(`/api/production/recipe-packaging-variations?id=${l.id}`, { method: "DELETE" }),
        ),
      ]);
      if (results.some((r) => !r.ok)) throw new Error("Some changes failed to save.");

      await onSaved();
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const changedCount = useMemo(() => {
    let n = 0;
    for (const id of selected) if (!linkedVariationIds.has(id)) n++;
    for (const l of currentLinks) if (!selected.has(l.variation_id)) n++;
    return n;
  }, [selected, linkedVariationIds, currentLinks]);

  return (
    <Modal title={`Packaging Variations — ${recipeName}`} onClose={onClose} wide>
      <div className="space-y-3">
        <p className="text-xs text-muted">
          Select every packaging variation this recipe is packaged as. Use search and the filters to narrow a large catalog.
        </p>

        <FilterBar activeCount={activeCount} onClear={resetFilters}>
          <SearchInput value={q} onChange={setQ} placeholder="Search variations…" />
          <FilterChips label="Type" options={PKGVAR_TYPE_OPTIONS} value={typeF} onChange={setTypeF} />
          <FilterChips label="Format" options={PKGVAR_FORMAT_OPTIONS} value={formatF} onChange={setFormatF} />
          {partnerOptions.length > 1 && (
            <FilterChips label="Partner" options={partnerOptions} value={partnerF} onChange={setPartnerF} />
          )}
        </FilterBar>

        <div className="flex items-center justify-between text-xs">
          <span className="text-muted">
            {selected.size} selected · {filtered.length} shown
          </span>
          <button
            type="button"
            onClick={toggleAllFiltered}
            disabled={filteredIds.length === 0}
            className="text-accent hover:text-accent-soft disabled:text-disabled disabled:hover:text-disabled"
          >
            {allFilteredSelected ? "Deselect shown" : `Select shown (${filteredIds.length})`}
          </button>
        </div>

        <div className="rounded-lg border border-line overflow-y-auto max-h-[52vh]">
          {filtered.length === 0 ? (
            <p className="text-faint text-sm px-4 py-6 text-center">No variations match the current filters.</p>
          ) : (
            groups.map((g) => (
              <div key={g.key}>
                <div className="sticky top-0 z-10 bg-surface-mid/95 px-3 py-1.5 border-b border-line/60 backdrop-blur">
                  <span className="text-xs font-semibold text-muted uppercase tracking-wider">{g.label}</span>
                  <span className="text-xs text-faint ml-2">{g.items.length}</span>
                </div>
                {g.items.map((v) => {
                  const isKeg = v.container?.type === "keg";
                  const checked = selected.has(v.id);
                  return (
                    <label
                      key={v.id}
                      className={`flex items-center gap-3 px-3 py-2 border-b border-line/40 cursor-pointer transition-colors ${
                        checked ? "bg-accent-muted/20" : "hover:bg-surface/50"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(v.id)}
                        className="rounded shrink-0"
                      />
                      <span className="text-sm text-strong font-medium flex-1 min-w-0 truncate">{v.name}</span>
                      <span className="flex items-center gap-1.5 shrink-0">
                        {isKeg ? (
                          <span className={`text-xs px-1.5 py-0.5 rounded ${KEG_TAG_BADGE} font-medium uppercase`}>Keg</span>
                        ) : (
                          <>
                            <span className="text-xs px-1.5 py-0.5 rounded border border-info-border bg-info-surface/30 text-info font-medium uppercase">Can</span>
                            <span className="text-xs px-1.5 py-0.5 rounded border border-line-strong text-secondary">
                              {v.label ? "Labeled" : "Printed"}
                            </span>
                          </>
                        )}
                        <span className="text-xs text-muted whitespace-nowrap">
                          {v.contract_brewing_partners?.company_name ?? "Generic"}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {error && <p className="text-xs text-danger">{error}</p>}

        <div className="flex items-center justify-end gap-2 pt-2 border-t border-line">
          <span className="text-xs text-muted mr-auto">
            {changedCount > 0 ? `${changedCount} change${changedCount !== 1 ? "s" : ""} pending` : "No changes"}
          </span>
          <button type="button" onClick={onClose} className="btn-secondary" disabled={saving}>
            Cancel
          </button>
          <button type="button" onClick={handleSave} className="btn-primary" disabled={saving || changedCount === 0}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
