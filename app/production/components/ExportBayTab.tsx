"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRecipesQuery, useContractPartnersQuery, fetchJson } from "../hooks/queries";
import type { AvailableInventoryLine, BatchAllocation, ExportChannel } from "../types";
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

interface RecipeAllocationGroup {
  recipeId: string;
  recipeName: string;
  partnerGroups: CustomerRecipeGroup[];
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
  const [showAdHoc, setShowAdHoc] = useState(false);

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

  // Nest the partner groups underneath their recipe, so every allocation for
  // a given recipe (across all partners) shows together in one card.
  const recipeGroups = new Map<string, RecipeAllocationGroup>();
  for (const g of groups.values()) {
    const existing = recipeGroups.get(g.recipeId);
    if (existing) {
      existing.partnerGroups.push(g);
    } else {
      recipeGroups.set(g.recipeId, { recipeId: g.recipeId, recipeName: g.recipeName, partnerGroups: [g] });
    }
  }

  // Group inventory by recipe.
  const inventoryByRecipe = new Map<string, AvailableInventoryLine[]>();
  for (const line of inventory) {
    const list = inventoryByRecipe.get(line.recipe_id) ?? [];
    list.push(line);
    inventoryByRecipe.set(line.recipe_id, list);
  }

  // Unified, sorted recipe list — union of inventory and allocation recipe IDs.
  // Sort by urgency: earliest unfulfilled due date first; no-due-date after; inventory-only last.
  function earliestDueDate(recipeId: string): string | null {
    const rg = recipeGroups.get(recipeId);
    if (!rg) return null;
    let earliest: string | null = null;
    for (const pg of rg.partnerGroups) {
      for (const a of pg.allocations) {
        if (a.fulfilled) continue;
        const d = a.commitments?.desired_delivery_date ?? null;
        if (d && (!earliest || d < earliest)) earliest = d;
      }
    }
    return earliest;
  }

  const allRecipeIds = Array.from(
    new Set([...inventoryByRecipe.keys(), ...recipeGroups.keys()])
  ).sort((a, b) => {
    const hasAllocA = recipeGroups.has(a);
    const hasAllocB = recipeGroups.has(b);
    // Inventory-only recipes go last
    if (!hasAllocA && hasAllocB) return 1;
    if (hasAllocA && !hasAllocB) return -1;
    const dA = earliestDueDate(a);
    const dB = earliestDueDate(b);
    if (dA && dB) return dA < dB ? -1 : dA > dB ? 1 : 0;
    if (dA) return -1;
    if (dB) return 1;
    return 0;
  });

  function afterShip() {
    qc.invalidateQueries({ queryKey: queryKeys.production.exportBayInventory() });
    qc.invalidateQueries({ queryKey: queryKeys.production.allocations() });
    setShipGroup(null);
  }

  const anyData = inventory.length > 0 || recipeGroups.size > 0;

  return (
    <div className="space-y-6">
      {/* ── Column headers ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-zinc-300">Available</h3>
          <button
            onClick={() => setShowAdHoc(true)}
            disabled={inventory.length === 0}
            title={inventory.length === 0 ? "No packaged inventory available" : undefined}
            className="text-xs px-2.5 py-1 border border-amber-700 text-amber-400 hover:bg-amber-900/30 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
          >
            + Ad-Hoc Export
          </button>
        </div>
        <h3 className="text-sm font-medium text-zinc-300">Allocations</h3>
      </div>

      {!anyData ? (
        <p className="text-sm text-zinc-600">Nothing to show yet.</p>
      ) : (
        <div className="space-y-4">
          {allRecipeIds.map((recipeId) => {
            const lines = inventoryByRecipe.get(recipeId) ?? [];
            const rg = recipeGroups.get(recipeId);
            const hasInventory = lines.length > 0;
            const recipeName = recipeNameById.get(recipeId) ?? "Unknown recipe";
            return (
              <div key={recipeId} className="grid grid-cols-1 md:grid-cols-2 gap-6 items-stretch">
                {/* Left: inventory */}
                <div className="rounded-lg border border-zinc-800 overflow-hidden flex flex-col">
                  <div className="px-3 py-2 bg-zinc-900/60 border-b border-zinc-800 text-sm font-medium text-zinc-100">
                    {recipeName}
                  </div>
                  {lines.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-zinc-600 italic flex-1">No inventory available</div>
                  ) : (
                    <div className="divide-y divide-zinc-800 flex-1">
                      {lines.map((l) => (
                        <div key={l.variation_id} className="flex items-center justify-between px-3 py-2 text-sm">
                          <span className="text-zinc-300">{l.variation_name}</span>
                          <span className="text-zinc-400 tabular-nums">{l.quantity_on_hand}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                {/* Right: allocations */}
                <div className="rounded-lg border border-zinc-800 overflow-hidden flex flex-col">
                  <div className="px-3 py-2 bg-zinc-900/60 border-b border-zinc-800 text-sm font-medium text-zinc-100">
                    {recipeName}
                  </div>
                  {!rg ? (
                    <div className="px-3 py-2 text-xs text-zinc-600 italic flex-1">No active allocations</div>
                  ) : (
                    <div className="divide-y divide-zinc-800/60 flex-1">
                      {rg.partnerGroups.map((g) => (
                        <div key={g.partnerId}>
                          <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-900/30">
                            <span className="text-xs font-medium text-zinc-400">{g.partnerName}</span>
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
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {shipGroup && (
        <ShipModal
          group={shipGroup}
          inventoryLines={inventoryByRecipe.get(shipGroup.recipeId) ?? []}
          onClose={() => setShipGroup(null)}
          onDone={afterShip}
        />
      )}

      {showAdHoc && (
        <AdHocExportModal
          inventoryByRecipe={inventoryByRecipe}
          recipeNameById={recipeNameById}
          onClose={() => setShowAdHoc(false)}
          onDone={() => {
            afterShip();
            setShowAdHoc(false);
          }}
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
  const [variationId, setVariationId] = useState(inventoryLines[0]?.variation_id ?? "");
  const [quantity, setQuantity] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
          variation_id: variationId,
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
            <select className="inp w-full" value={variationId} onChange={(e) => setVariationId(e.target.value)}>
              {inventoryLines.map((l) => (
                <option key={l.variation_id} value={l.variation_id}>
                  {l.variation_name} ({l.quantity_on_hand} available)
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

function AdHocExportModal({ inventoryByRecipe, recipeNameById, onClose, onDone }: {
  inventoryByRecipe: Map<string, AvailableInventoryLine[]>;
  recipeNameById: Map<string, string>;
  onClose: () => void;
  onDone: () => void;
}) {
  const { data: partners = [] } = useContractPartnersQuery();

  const recipeIds = [...inventoryByRecipe.keys()];
  const [channel, setChannel] = useState<ExportChannel>("taproom");
  const [partnerId, setPartnerId] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [recipeId, setRecipeId] = useState(recipeIds[0] ?? "");
  const linesForRecipe = inventoryByRecipe.get(recipeId) ?? [];
  const [variationId, setVariationId] = useState(linesForRecipe[0]?.variation_id ?? "");
  const [quantity, setQuantity] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleSelectRecipe(id: string) {
    setRecipeId(id);
    const lines = inventoryByRecipe.get(id) ?? [];
    setVariationId(lines[0]?.variation_id ?? "");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (channel !== "taproom" && partnerId) {
      try {
        const check = await fetchJson<{ hasActiveAllocation: boolean }>(
          `/api/production/export-bay/active-allocation-check?partner_id=${partnerId}&recipe_id=${recipeId}`
        );
        if (check.hasActiveAllocation) {
          const proceed = window.confirm(
            "This customer already has an active allocation for this recipe — are you sure you want to ship ad-hoc instead of crediting that allocation?"
          );
          if (!proceed) return;
        }
      } catch {
        // Advisory check failing should never block the actual shipment.
      }
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/production/export-bay/ship-adhoc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel,
          partner_id: channel === "taproom" ? null : partnerId,
          recipient_name: channel === "taproom" ? (recipientName || null) : null,
          recipe_id: recipeId,
          variation_id: variationId,
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
        <h3 className="text-sm font-medium text-zinc-100">Ad-Hoc Export</h3>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="text-xs text-zinc-400 block mb-1">Channel</label>
            <select className="inp w-full" value={channel} onChange={(e) => setChannel(e.target.value as ExportChannel)}>
              <option value="taproom">Taproom</option>
              <option value="distribution">Distribution</option>
              <option value="contract_brewing">Contract Brewing</option>
              <option value="wholesale">Wholesale</option>
            </select>
          </div>
          {channel !== "taproom" && (
            <div>
              <label className="text-xs text-zinc-400 block mb-1">Partner</label>
              <select className="inp w-full" required value={partnerId} onChange={(e) => setPartnerId(e.target.value)}>
                <option value="" disabled>Select a partner…</option>
                {partners.map((p) => (
                  <option key={p.id} value={p.id}>{p.company_name}</option>
                ))}
              </select>
            </div>
          )}
          {channel === "taproom" && (
            <div>
              <label className="text-xs text-zinc-400 block mb-1">Recipient name (optional)</label>
              <input className="inp w-full" value={recipientName} onChange={(e) => setRecipientName(e.target.value)} />
            </div>
          )}
          <div>
            <label className="text-xs text-zinc-400 block mb-1">Recipe</label>
            <select className="inp w-full" value={recipeId} onChange={(e) => handleSelectRecipe(e.target.value)}>
              {recipeIds.map((id) => (
                <option key={id} value={id}>{recipeNameById.get(id) ?? "Unknown recipe"}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-zinc-400 block mb-1">Packaging</label>
            <select className="inp w-full" value={variationId} onChange={(e) => setVariationId(e.target.value)}>
              {linesForRecipe.map((l) => (
                <option key={l.variation_id} value={l.variation_id}>
                  {l.variation_name} ({l.quantity_on_hand} available)
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
            <button type="submit" disabled={submitting || linesForRecipe.length === 0} className="text-xs px-3 py-1.5 bg-amber-700 hover:bg-amber-600 text-zinc-100 rounded disabled:opacity-50">
              {submitting ? "Shipping…" : "Ship"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
