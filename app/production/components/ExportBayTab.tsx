"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRecipesQuery, useContractPartnersQuery, fetchJson } from "../hooks/queries";
import type { AvailableInventoryLine, BatchAllocation } from "../types";
import { queryKeys } from "@/lib/query-keys";

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

interface CustomerRecipeGroup {
  partnerId: string;
  partnerName: string;
  recipeId: string;
  recipeName: string;
  allocations: BatchAllocation[];
}

export default function ExportBayTab() {
  const qc = useQueryClient();
  const { data: inventory = [], isLoading: inventoryLoading } = useQuery({
    queryKey: queryKeys.production.exportBayInventory(),
    queryFn: () => fetchJson<AvailableInventoryLine[]>("/api/production/export-bay/inventory"),
  });
  const { data: allocations = [], isLoading: allocationsLoading } = useQuery({
    queryKey: queryKeys.production.allocations(),
    queryFn: () => fetchJson<BatchAllocation[]>("/api/production/allocations"),
  });
  const { data: recipes = [] } = useRecipesQuery();
  const { data: partners = [] } = useContractPartnersQuery();

  const recipeNameById = new Map(recipes.map((r) => [r.id, r.beer_name]));
  const partnerNameById = new Map(partners.map((p) => [p.id, p.company_name]));

  const [shipGroup, setShipGroup] = useState<CustomerRecipeGroup | null>(null);

  if (inventoryLoading || allocationsLoading) {
    return <p className="text-sm text-zinc-600 py-8 text-center">Loading…</p>;
  }

  // Group allocations by partner + recipe, excluding taproom (no customer to group by).
  const groups = new Map<string, CustomerRecipeGroup>();
  for (const a of allocations) {
    if (a.channel === "taproom") continue;
    const partnerId = a.partner_id;
    const recipeId = a.brew_batches?.recipe_id;
    if (!partnerId || !recipeId) continue;
    const key = `${partnerId}|${recipeId}`;
    const existing = groups.get(key);
    if (existing) {
      existing.allocations.push(a);
    } else {
      groups.set(key, {
        partnerId,
        partnerName: partnerNameById.get(partnerId) ?? "Unknown",
        recipeId,
        recipeName: recipeNameById.get(recipeId) ?? "Unknown recipe",
        allocations: [a],
      });
    }
  }

  // Group inventory by recipe.
  const inventoryByRecipe = new Map<string, AvailableInventoryLine[]>();
  for (const line of inventory) {
    const list = inventoryByRecipe.get(line.recipe_id) ?? [];
    list.push(line);
    inventoryByRecipe.set(line.recipe_id, list);
  }

  function afterShip() {
    qc.invalidateQueries({ queryKey: queryKeys.production.exportBayInventory() });
    qc.invalidateQueries({ queryKey: queryKeys.production.allocations() });
    setShipGroup(null);
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      {/* ── Left column: Available ── */}
      <div>
        <h3 className="text-sm font-medium text-zinc-300 mb-3">Available</h3>
        {inventory.length === 0 ? (
          <p className="text-sm text-zinc-600">Nothing in cold storage right now.</p>
        ) : (
          <div className="space-y-4">
            {[...inventoryByRecipe.entries()].map(([recipeId, lines]) => (
              <div key={recipeId} className="rounded-lg border border-zinc-800 overflow-hidden">
                <div className="px-3 py-2 bg-zinc-900/60 border-b border-zinc-800 text-sm font-medium text-zinc-100">
                  {recipeNameById.get(recipeId) ?? "Unknown recipe"}
                </div>
                <div className="divide-y divide-zinc-800">
                  {lines.map((l) => (
                    <div key={`${l.packaging_item_id}|${l.variant_label}`} className="flex items-center justify-between px-3 py-2 text-sm">
                      <span className="text-zinc-300">{l.variant_label}</span>
                      <span className="text-zinc-400 tabular-nums">{l.quantity_on_hand}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Right column: Allocations ── */}
      <div>
        <h3 className="text-sm font-medium text-zinc-300 mb-3">Allocations</h3>
        {groups.size === 0 ? (
          <p className="text-sm text-zinc-600">No active allocations.</p>
        ) : (
          <div className="space-y-4">
            {[...groups.values()].map((g) => {
              const hasInventory = (inventoryByRecipe.get(g.recipeId) ?? []).length > 0;
              return (
              <div key={`${g.partnerId}|${g.recipeId}`} className="rounded-lg border border-zinc-800 overflow-hidden">
                <div className="flex items-center justify-between px-3 py-2 bg-zinc-900/60 border-b border-zinc-800">
                  <span className="text-sm font-medium text-zinc-100">{g.partnerName} — {g.recipeName}</span>
                  <button
                    onClick={() => setShipGroup(g)}
                    disabled={!hasInventory}
                    title={hasInventory ? undefined : "No packaged inventory available for this recipe"}
                    className="text-xs px-2.5 py-1 border border-amber-700 text-amber-400 hover:bg-amber-900/30 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                  >
                    Ship
                  </button>
                </div>
                <div className="divide-y divide-zinc-800">
                  {g.allocations.map((a) => (
                    <div key={a.id} className="flex items-center justify-between px-3 py-2 text-sm">
                      <div className="flex items-center gap-2">
                        <span className="text-zinc-400 font-mono text-xs">
                          {a.brew_batches ? `#${a.brew_batches.batch_number}` : "—"}
                        </span>
                        <span className="text-zinc-500 text-xs">Due {fmtDate(a.commitments?.desired_delivery_date ?? null)}</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-zinc-400 tabular-nums text-xs">
                          {a.exported_bbl.toFixed(2)} / {a.allocated_bbl != null ? a.allocated_bbl.toFixed(2) : "—"} BBL
                        </span>
                        {a.allocated_bbl == null ? (
                          <span className="text-xs text-zinc-600">Pending production</span>
                        ) : a.fulfilled ? (
                          <span className="text-xs text-emerald-400">Fulfilled</span>
                        ) : (
                          <span className="text-xs text-amber-400">
                            {a.allocated_bbl > 0 ? `${((a.exported_bbl / a.allocated_bbl) * 100).toFixed(0)}%` : "Unfulfilled"}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
            })}
          </div>
        )}
      </div>

      {shipGroup && (
        <ShipModal
          group={shipGroup}
          inventoryLines={inventoryByRecipe.get(shipGroup.recipeId) ?? []}
          onClose={() => setShipGroup(null)}
          onDone={afterShip}
        />
      )}
    </div>
  );
}

function ShipModal({ group, inventoryLines, onClose, onDone }: {
  group: CustomerRecipeGroup;
  inventoryLines: AvailableInventoryLine[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [packagingItemId, setPackagingItemId] = useState(inventoryLines[0]?.packaging_item_id ?? "");
  const [variantLabel, setVariantLabel] = useState(inventoryLines[0]?.variant_label ?? "");
  const [quantity, setQuantity] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleSelectLine(key: string) {
    const line = inventoryLines.find((l) => `${l.packaging_item_id}|${l.variant_label}` === key);
    if (line) {
      setPackagingItemId(line.packaging_item_id);
      setVariantLabel(line.variant_label);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/production/export-bay/ship", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          partner_id: group.partnerId,
          recipe_id: group.recipeId,
          packaging_item_id: packagingItemId,
          variant_label: variantLabel,
          quantity: parseFloat(quantity),
          notes: notes || null,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      onDone();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-zinc-900 border border-zinc-700 rounded-lg p-5 w-full max-w-md space-y-4">
        <h3 className="text-sm font-medium text-zinc-100">Ship to {group.partnerName} — {group.recipeName}</h3>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="text-xs text-zinc-400 block mb-1">Packaging</label>
            <select
              className="inp w-full"
              value={`${packagingItemId}|${variantLabel}`}
              onChange={(e) => handleSelectLine(e.target.value)}
            >
              {inventoryLines.map((l) => (
                <option key={`${l.packaging_item_id}|${l.variant_label}`} value={`${l.packaging_item_id}|${l.variant_label}`}>
                  {l.variant_label} ({l.quantity_on_hand} available)
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-zinc-400 block mb-1">Quantity</label>
            <input type="number" min="0" step="1" className="inp w-full" required value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          </div>
          <div>
            <label className="text-xs text-zinc-400 block mb-1">Notes</label>
            <input className="inp w-full" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          {error && <p className="text-xs text-red-400">{error}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="text-xs px-3 py-1.5 text-zinc-400 hover:text-zinc-200">Cancel</button>
            <button type="submit" disabled={submitting || inventoryLines.length === 0} className="text-xs px-3 py-1.5 bg-amber-700 hover:bg-amber-600 text-zinc-100 rounded disabled:opacity-50">
              {submitting ? "Shipping…" : "Ship"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
