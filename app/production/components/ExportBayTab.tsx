"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRecipesQuery, useContractPartnersQuery, fetchJson } from "../hooks/queries";
import type { AvailableInventoryLine, BatchAllocation, ExportChannel } from "../types";
import { queryKeys } from "@/lib/query-keys";

// ── Channel display ────────────────────────────────────────────────────────────

const CHANNEL_BADGE: Record<string, { label: string; cls: string }> = {
  distribution:     { label: "Distribution",     cls: "border-cyan-700   bg-cyan-900/30   text-cyan-300"   },
  contract_brewing: { label: "Contract Brewing", cls: "border-rose-700   bg-rose-900/30   text-rose-300"   },
  wholesale:        { label: "Wholesale",        cls: "border-purple-700 bg-purple-900/30 text-purple-300" },
  safety_stock:     { label: "Safety Stock",     cls: "border-zinc-600   bg-zinc-800/60   text-zinc-400"   },
};

const CHANNEL_CHIP_LABELS: Record<string, string> = {
  distribution:     "Distribution",
  contract_brewing: "Contract Brewing",
  wholesale:        "Wholesale",
  safety_stock:     "Safety Stock",
};

function ChannelBadge({ channel }: { channel: string }) {
  const cfg = CHANNEL_BADGE[channel];
  if (!cfg) return null;
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium shrink-0 ${cfg.cls}`}>
      {cfg.label}
    </span>
  );
}

// ── Filter chips ───────────────────────────────────────────────────────────────

function FilterChips({ label, options, value, onChange }: {
  label: string;
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className="text-xs text-zinc-500 mr-0.5">{label}:</span>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`text-[11px] px-2 py-0.5 rounded border transition-colors ${
            value === o.value
              ? "border-amber-600 bg-amber-900/40 text-amber-300"
              : "border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-300"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function stockSummary(lines: AvailableInventoryLine[]): string {
  const cans = lines.filter((l) => l.container_type === "can").reduce((s, l) => s + l.quantity_on_hand, 0);
  const kegs = lines.filter((l) => l.container_type === "keg").reduce((s, l) => s + l.quantity_on_hand, 0);
  if (cans > 0 && kegs > 0) return `${cans} cans · ${kegs} kegs`;
  if (cans > 0) return `${cans} units`;
  if (kegs > 0) return `${kegs} kegs`;
  return "—";
}

function sortAllocations(list: BatchAllocation[]): BatchAllocation[] {
  return [...list].sort((a, b) => {
    const dA = a.commitments?.desired_delivery_date ?? null;
    const dB = b.commitments?.desired_delivery_date ?? null;
    if (dA && dB) return dA < dB ? -1 : dA > dB ? 1 : 0;
    if (dA) return -1;
    if (dB) return 1;
    return a.created_at < b.created_at ? -1 : 1;
  });
}

// ── Types ──────────────────────────────────────────────────────────────────────

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

// ── Main component ─────────────────────────────────────────────────────────────

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

  const recipeNameById  = new Map(recipes.map((r) => [r.id, r.beer_name]));
  const partnerNameById = new Map(partners.map((p) => [p.id, p.company_name]));

  // ── UI state ──────────────────────────────────────────────────────────────────
  const [shipGroup,         setShipGroup]         = useState<CustomerRecipeGroup | null>(null);
  const [showAdHoc,         setShowAdHoc]         = useState(false);
  const [expandedFulfilled, setExpandedFulfilled] = useState<Set<string>>(new Set());

  // Search / filter / sort
  const [search,         setSearch]         = useState("");
  const [filterStatus,   setFilterStatus]   = useState("all");
  const [filterChannel,  setFilterChannel]  = useState("all");
  const [filterPartner,  setFilterPartner]  = useState("all");
  const [sortBy,         setSortBy]         = useState("urgency");

  function toggleFulfilled(recipeId: string) {
    setExpandedFulfilled((prev) => {
      const next = new Set(prev);
      if (next.has(recipeId)) next.delete(recipeId);
      else next.add(recipeId);
      return next;
    });
  }

  if (inventoryLoading || allocationsLoading) {
    return <p className="text-sm text-zinc-600 py-8 text-center">Loading…</p>;
  }

  // ── Group allocations by partner+recipe, then nest under recipe ──────────────

  const groups = new Map<string, CustomerRecipeGroup>();
  for (const a of allocations) {
    if (a.channel === "taproom") continue;
    const partnerId = a.partner_id;
    const recipeId  = a.brew_batches?.recipe_id;
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

  const recipeGroups = new Map<string, RecipeAllocationGroup>();
  for (const g of groups.values()) {
    const existing = recipeGroups.get(g.recipeId);
    if (existing) {
      existing.partnerGroups.push(g);
    } else {
      recipeGroups.set(g.recipeId, { recipeId: g.recipeId, recipeName: g.recipeName, partnerGroups: [g] });
    }
  }

  const inventoryByRecipe = new Map<string, AvailableInventoryLine[]>();
  for (const line of inventory) {
    const list = inventoryByRecipe.get(line.recipe_id) ?? [];
    list.push(line);
    inventoryByRecipe.set(line.recipe_id, list);
  }

  // ── Chip option derivation ────────────────────────────────────────────────────

  // Channels present in loaded allocations (taproom excluded — it has no allocations panel)
  const presentChannels = new Set<string>();
  for (const a of allocations) {
    if (a.channel !== "taproom") presentChannels.add(a.channel);
  }
  const channelChipOptions = [
    { value: "all", label: "All" },
    ...["distribution", "contract_brewing", "wholesale", "safety_stock"]
      .filter((c) => presentChannels.has(c))
      .map((c) => ({ value: c, label: CHANNEL_CHIP_LABELS[c] ?? c })),
  ];

  // Partners present in loaded allocations, sorted alphabetically
  const seenPartners = new Map<string, string>();
  for (const a of allocations) {
    if (a.partner_id && !seenPartners.has(a.partner_id)) {
      seenPartners.set(
        a.partner_id,
        a.contract_brewing_partners?.company_name ?? partnerNameById.get(a.partner_id) ?? "Unknown"
      );
    }
  }
  const partnerChipOptions = [
    { value: "all", label: "All" },
    ...Array.from(seenPartners.entries())
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([id, name]) => ({ value: id, label: name })),
  ];

  const showPartnerChips = partnerChipOptions.length > 2;

  // ── Sort helpers ──────────────────────────────────────────────────────────────

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

  function urgencySort(a: string, b: string): number {
    const hasAllocA = recipeGroups.has(a);
    const hasAllocB = recipeGroups.has(b);
    if (!hasAllocA && hasAllocB) return 1;
    if (hasAllocA && !hasAllocB) return -1;
    const dA = earliestDueDate(a);
    const dB = earliestDueDate(b);
    if (dA && dB) return dA < dB ? -1 : dA > dB ? 1 : 0;
    if (dA) return -1;
    if (dB) return 1;
    return 0;
  }

  // ── Filter + sort ─────────────────────────────────────────────────────────────

  const allRecipeIds = Array.from(new Set([...inventoryByRecipe.keys(), ...recipeGroups.keys()]));

  const q = search.trim().toLowerCase();
  const filteredRecipeIds = allRecipeIds
    .filter((recipeId) => {
      const recipeName = recipeNameById.get(recipeId) ?? "";
      const rg         = recipeGroups.get(recipeId);
      const lines      = inventoryByRecipe.get(recipeId) ?? [];

      // Search
      if (q && !recipeName.toLowerCase().includes(q)) return false;

      // Status
      if (filterStatus === "pending") {
        const hasUnfulfilled = rg?.partnerGroups.some((g) => g.allocations.some((a) => !a.fulfilled)) ?? false;
        if (!hasUnfulfilled) return false;
      }
      if (filterStatus === "fulfilled") {
        if (!rg) return false;
        if (!rg.partnerGroups.every((g) => g.allocations.every((a) => a.fulfilled))) return false;
      }
      if (filterStatus === "inventory_only") {
        if (rg) return false;
        if (lines.length === 0) return false;
      }

      // Channel — recipe must have at least one allocation in the selected channel
      if (filterChannel !== "all") {
        const hasChannel = rg?.partnerGroups.some((g) =>
          g.allocations.some((a) => a.channel === filterChannel)
        ) ?? false;
        if (!hasChannel) return false;
      }

      // Partner — recipe must have at least one allocation from the selected partner
      if (filterPartner !== "all") {
        const hasPartner = rg?.partnerGroups.some((g) => g.partnerId === filterPartner) ?? false;
        if (!hasPartner) return false;
      }

      return true;
    })
    .sort((a, b) => {
      if (sortBy === "name") {
        return (recipeNameById.get(a) ?? "").localeCompare(recipeNameById.get(b) ?? "");
      }
      if (sortBy === "stock") {
        const sA = (inventoryByRecipe.get(a) ?? []).reduce((s, l) => s + l.quantity_on_hand, 0);
        const sB = (inventoryByRecipe.get(b) ?? []).reduce((s, l) => s + l.quantity_on_hand, 0);
        return sB - sA; // most stock first
      }
      return urgencySort(a, b);
    });

  const anyData     = inventory.length > 0 || recipeGroups.size > 0;
  const hasFilters  = q || filterStatus !== "all" || filterChannel !== "all" || filterPartner !== "all";
  const isFiltered  = filteredRecipeIds.length < allRecipeIds.length;

  function clearFilters() {
    setSearch("");
    setFilterStatus("all");
    setFilterChannel("all");
    setFilterPartner("all");
  }

  function afterShip() {
    qc.invalidateQueries({ queryKey: queryKeys.production.exportBayInventory() });
    qc.invalidateQueries({ queryKey: queryKeys.production.allocations() });
    setShipGroup(null);
  }

  return (
    <div className="space-y-3">

      {/* Search + Ad-Hoc Export */}
      <div className="flex items-center gap-3">
        <input
          type="search"
          placeholder="Search by recipe…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="inp flex-1 max-w-xs text-sm"
        />
        <button
          onClick={() => setShowAdHoc(true)}
          disabled={inventory.length === 0}
          title={inventory.length === 0 ? "No packaged inventory available" : undefined}
          className="ml-auto text-xs px-2.5 py-1 border border-amber-700 text-amber-400 hover:bg-amber-900/30 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent shrink-0"
        >
          + Ad-Hoc Export
        </button>
      </div>

      {/* Filter + sort chips */}
      <div className="flex flex-wrap gap-x-5 gap-y-1.5">
        <FilterChips
          label="Status"
          options={[
            { value: "all",            label: "All"       },
            { value: "pending",        label: "Pending"   },
            { value: "fulfilled",      label: "Fulfilled" },
            { value: "inventory_only", label: "Stock only" },
          ]}
          value={filterStatus}
          onChange={setFilterStatus}
        />
        {channelChipOptions.length > 2 && (
          <FilterChips
            label="Channel"
            options={channelChipOptions}
            value={filterChannel}
            onChange={setFilterChannel}
          />
        )}
        {showPartnerChips && (
          <FilterChips
            label="Partner"
            options={partnerChipOptions}
            value={filterPartner}
            onChange={setFilterPartner}
          />
        )}
        <FilterChips
          label="Sort"
          options={[
            { value: "urgency", label: "Urgency" },
            { value: "name",    label: "A–Z"     },
            { value: "stock",   label: "Stock"   },
          ]}
          value={sortBy}
          onChange={setSortBy}
        />
      </div>

      {/* Result count + clear */}
      {(isFiltered || hasFilters) && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-500">
            {filteredRecipeIds.length} of {allRecipeIds.length} recipe{allRecipeIds.length !== 1 ? "s" : ""}
          </span>
          {hasFilters && (
            <button onClick={clearFilters} className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors">
              Clear filters
            </button>
          )}
        </div>
      )}

      {/* Sticky column labels */}
      <div className="sticky top-0 z-10 bg-zinc-950 grid grid-cols-1 md:grid-cols-2 gap-6 py-2 border-b border-zinc-800/60">
        <h3 className="text-sm font-medium text-zinc-300">Available</h3>
        <h3 className="text-sm font-medium text-zinc-300">Allocations</h3>
      </div>

      {!anyData ? (
        <p className="text-sm text-zinc-600 pt-2">Nothing to show yet.</p>
      ) : filteredRecipeIds.length === 0 ? (
        <p className="text-sm text-zinc-600 pt-2">No recipes match the current filters.</p>
      ) : (
        <div className="space-y-6 pt-2">
          {filteredRecipeIds.map((recipeId) => {
            const lines        = inventoryByRecipe.get(recipeId) ?? [];
            const rg           = recipeGroups.get(recipeId);
            const hasInventory = lines.length > 0;
            const recipeName   = recipeNameById.get(recipeId) ?? "Unknown recipe";
            const showFulfilled = expandedFulfilled.has(recipeId);

            // Counts for section header
            const allAllocs      = rg ? rg.partnerGroups.flatMap((g) => g.allocations) : [];
            const pendingCount   = allAllocs.filter((a) => !a.fulfilled).length;
            const fulfilledCount = allAllocs.filter((a) => a.fulfilled).length;

            // Per-recipe: filter fulfilled when collapsed, sort allocations by due date
            const visiblePartnerGroups = rg
              ? rg.partnerGroups
                  .map((g) => ({
                    ...g,
                    allocations: sortAllocations(
                      showFulfilled ? g.allocations : g.allocations.filter((a) => !a.fulfilled)
                    ),
                  }))
                  .filter((g) => showFulfilled || g.allocations.length > 0)
              : [];

            return (
              <div key={recipeId} className="space-y-1.5">

                {/* Shared recipe section header */}
                <div className="flex items-center justify-between px-0.5">
                  <span className="text-sm font-medium text-zinc-200">{recipeName}</span>
                  <div className="flex items-center gap-2 text-xs">
                    {rg ? (
                      <>
                        {pendingCount > 0 && (
                          <span className="text-amber-400">{pendingCount} pending</span>
                        )}
                        {pendingCount > 0 && fulfilledCount > 0 && (
                          <span className="text-zinc-700">·</span>
                        )}
                        {fulfilledCount > 0 && (
                          <span className="text-zinc-600">{fulfilledCount} fulfilled</span>
                        )}
                      </>
                    ) : (
                      <span className="text-zinc-600">no allocations</span>
                    )}
                    {hasInventory && (
                      <>
                        <span className="text-zinc-700">·</span>
                        <span className="text-zinc-500">{stockSummary(lines)} in stock</span>
                      </>
                    )}
                  </div>
                </div>

                {/* Two-card row */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-stretch">

                  {/* Left: Available (inventory) */}
                  <div className={`rounded-lg border overflow-hidden flex flex-col ${
                    !hasInventory ? "border-dashed border-zinc-700" : "border-zinc-800"
                  }`}>
                    <div className="px-3 py-2 bg-zinc-900/60 border-b border-zinc-800 flex items-center justify-between">
                      <span className="text-xs font-medium text-zinc-500 uppercase tracking-wide">In Stock</span>
                      {hasInventory && (
                        <span className="text-xs text-zinc-400">{stockSummary(lines)}</span>
                      )}
                    </div>
                    {!hasInventory ? (
                      <div className="px-3 py-3 text-xs text-zinc-600 italic flex-1">
                        No inventory available
                      </div>
                    ) : (
                      <div className="divide-y divide-zinc-800 flex-1">
                        {[...lines].sort((a, b) => {
                          const t = (a.container_type === "keg" ? 0 : 1) - (b.container_type === "keg" ? 0 : 1);
                          return t !== 0 ? t : a.variation_name.localeCompare(b.variation_name);
                        }).map((l) => (
                          <div key={l.variation_id} className="flex items-center justify-between px-3 py-2 text-sm gap-2">
                            <div className="flex items-center gap-1.5 min-w-0">
                              {l.container_type === "keg" ? (
                                <span className="text-[10px] px-1.5 py-0.5 rounded border border-orange-700 bg-orange-900/30 text-orange-300 font-medium uppercase shrink-0">Keg</span>
                              ) : l.container_type === "can" ? (
                                <span className="text-[10px] px-1.5 py-0.5 rounded border border-blue-700 bg-blue-900/30 text-blue-300 font-medium uppercase shrink-0">Can</span>
                              ) : null}
                              <span className="text-zinc-300 truncate">{l.variation_name}</span>
                            </div>
                            <span className="text-zinc-400 tabular-nums shrink-0">{l.quantity_on_hand}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Right: Allocations */}
                  <div className="rounded-lg border border-zinc-800 overflow-hidden flex flex-col">
                    {!rg ? (
                      <div className="px-3 py-3 text-xs text-zinc-600 italic flex-1">
                        No active allocations
                      </div>
                    ) : (
                      <div className="divide-y divide-zinc-800/60 flex-1">
                        {visiblePartnerGroups.length === 0 ? (
                          <div className="px-3 py-3 text-xs text-zinc-600 italic">
                            All allocations fulfilled
                          </div>
                        ) : (
                          visiblePartnerGroups.map((g) => (
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
                                  <div key={a.id} className="flex items-center justify-between px-3 py-2 text-sm gap-2">
                                    <div className="flex items-center gap-2 min-w-0">
                                      <ChannelBadge channel={a.channel} />
                                      <span className="text-zinc-400 font-mono text-xs shrink-0">
                                        {a.brew_batches ? `#${a.brew_batches.batch_number}` : "—"}
                                      </span>
                                      <span className="text-zinc-500 text-xs truncate">
                                        Due {fmtDate(a.commitments?.desired_delivery_date ?? null)}
                                      </span>
                                    </div>
                                    <div className="flex items-center gap-3 shrink-0">
                                      <span className="text-zinc-400 tabular-nums text-xs">
                                        {a.exported_bbl.toFixed(2)} / {a.allocated_bbl != null ? a.allocated_bbl.toFixed(2) : "—"} BBL
                                      </span>
                                      {a.allocated_bbl == null ? (
                                        <span className="text-xs text-zinc-600">Pending production</span>
                                      ) : a.fulfilled ? (
                                        <span className="text-xs text-emerald-400">Fulfilled</span>
                                      ) : (
                                        <span className="text-xs text-amber-400">
                                          {a.allocated_bbl > 0
                                            ? `${((a.exported_bbl / a.allocated_bbl) * 100).toFixed(0)}%`
                                            : "Unfulfilled"}
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          ))
                        )}
                        {fulfilledCount > 0 && (
                          <div className="px-3 py-2">
                            <button
                              onClick={() => toggleFulfilled(recipeId)}
                              className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
                            >
                              {showFulfilled ? "− Hide fulfilled" : `+ Show ${fulfilledCount} fulfilled`}
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

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

// ── ShipModal ──────────────────────────────────────────────────────────────────

function ShipModal({ group, inventoryLines, onClose, onDone }: {
  group: CustomerRecipeGroup;
  inventoryLines: AvailableInventoryLine[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [variationId, setVariationId] = useState(inventoryLines[0]?.variation_id ?? "");
  const [quantity,    setQuantity]    = useState("");
  const [notes,       setNotes]       = useState("");
  const [submitting,  setSubmitting]  = useState(false);
  const [error,       setError]       = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/production/export-bay/ship", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          partner_id:   group.partnerId,
          recipe_id:    group.recipeId,
          variation_id: variationId,
          quantity:     parseFloat(quantity),
          notes:        notes || null,
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
        <h3 className="text-sm font-medium text-zinc-100">
          Ship to {group.partnerName} — {group.recipeName}
        </h3>
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
            <button
              type="submit"
              disabled={submitting || inventoryLines.length === 0}
              className="text-xs px-3 py-1.5 bg-amber-700 hover:bg-amber-600 text-zinc-100 rounded disabled:opacity-50"
            >
              {submitting ? "Shipping…" : "Ship"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── AdHocExportModal ───────────────────────────────────────────────────────────

function AdHocExportModal({ inventoryByRecipe, recipeNameById, onClose, onDone }: {
  inventoryByRecipe: Map<string, AvailableInventoryLine[]>;
  recipeNameById: Map<string, string>;
  onClose: () => void;
  onDone: () => void;
}) {
  const { data: partners = [] } = useContractPartnersQuery();

  const recipeIds = [...inventoryByRecipe.keys()];
  const [channel,       setChannel]       = useState<ExportChannel>("taproom");
  const [partnerId,     setPartnerId]     = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [recipeId,      setRecipeId]      = useState(recipeIds[0] ?? "");
  const linesForRecipe = inventoryByRecipe.get(recipeId) ?? [];
  const [variationId,   setVariationId]   = useState(linesForRecipe[0]?.variation_id ?? "");
  const [quantity,      setQuantity]      = useState("");
  const [notes,         setNotes]         = useState("");
  const [submitting,    setSubmitting]    = useState(false);
  const [error,         setError]         = useState<string | null>(null);

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
          partner_id:     channel === "taproom" ? null : partnerId,
          recipient_name: channel === "taproom" ? (recipientName || null) : null,
          recipe_id:      recipeId,
          variation_id:   variationId,
          quantity:       parseFloat(quantity),
          notes:          notes || null,
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
            <button
              type="submit"
              disabled={submitting || linesForRecipe.length === 0}
              className="text-xs px-3 py-1.5 bg-amber-700 hover:bg-amber-600 text-zinc-100 rounded disabled:opacity-50"
            >
              {submitting ? "Shipping…" : "Ship"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
