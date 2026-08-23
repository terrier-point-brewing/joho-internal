"use client";

import { useState, useEffect, useMemo } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { useRecipesQuery, useContractPartnersQuery, fetchJson } from "../hooks/queries";
import type { AvailableInventoryLine, BatchAllocation, ExportChannel } from "../types";
import { assessWriteOff, type ShipmentWarning } from "@/lib/production/allocationReserve";
import { queryKeys } from "@/lib/query-keys";
import { CHANNEL_COLOR, KEG_TAG_BADGE } from "../lib/categoryColors";
import FilterBar from "@/app/components/ui/FilterBar";
import FilterChips from "@/app/components/ui/FilterChips";
import SearchInput from "@/app/components/ui/SearchInput";
import { useTableControls } from "@/app/components/ui/useTableControls";
import type { ControlsConfig } from "@/lib/table/types";
import Card from "@/app/components/ui/Card";
import { Modal } from "@/app/components/ui/Modal";
import ColdStorageTransformModal from "./ColdStorageTransformModal";

function formatShipmentWarning(w: ShipmentWarning): string {
  switch (w.type) {
    case "guarantee_coverage":
      return `Dips into deposit-reserved beer — after this shipment only ${w.onHandAfterBbl.toFixed(2)} BBL would remain on a batch that still owes ${w.reservedBbl.toFixed(2)} BBL to contract deposits.`;
    case "under_production":
      return `A batch has produced ${w.producedBbl.toFixed(2)} of ${w.guaranteedBbl.toFixed(2)} BBL guaranteed to contract deposits — final yield may fall short.`;
    case "over_booked":
      return `Shipped ${w.overBbl.toFixed(2)} BBL beyond this customer's booked deposit for this recipe.`;
  }
}

// Progress denominator: contract allocations measure against their booked deposit;
// soft allocations against their produced-so-far share. null = nothing produced yet.
function allocDenomBbl(a: BatchAllocation): number | null {
  const d = a.deposit_backed ? a.booked_bbl : a.realizable_bbl;
  return d != null && d > 0 ? d : null;
}

// ── Channel display ────────────────────────────────────────────────────────────

const CHANNEL_BADGE: Record<string, { label: string; cls: string }> = {
  distribution:     { label: "Distribution",     cls: `border ${CHANNEL_COLOR.distribution.bg} ${CHANNEL_COLOR.distribution.text} ${CHANNEL_COLOR.distribution.border}` },
  contract_brewing: { label: "Contract Brewing", cls: `border ${CHANNEL_COLOR.contract_brewing.bg} ${CHANNEL_COLOR.contract_brewing.text} ${CHANNEL_COLOR.contract_brewing.border}` },
  wholesale:        { label: "Wholesale",        cls: `border ${CHANNEL_COLOR.wholesale.bg} ${CHANNEL_COLOR.wholesale.text} ${CHANNEL_COLOR.wholesale.border}` },
  safety_stock:     { label: "Safety Stock",     cls: "border border-line-subtle bg-surface-mid/60 text-secondary" },
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

/** A cold-storage lot (variation + batch) still eligible to retroactively cover
 *  a phantom export. */
interface PhantomEligibleLot {
  variationId: string;
  variationName: string;
  batchId: string;
  batchCode: string;
  onHand: number;
}

/** An open taproom phantom alert — barrel excise was booked with no
 *  cold-storage stock to deduct (`export_transactions.is_phantom = true`,
 *  unacknowledged). See GET /api/production/taproom-consumption/phantom-alerts.
 *
 *  These are NOT all draft swaps. A keg or can sale that outran cold storage
 *  books the same kind of row, and `origin` is what tells them apart — the two
 *  are grouped separately below because a drained tap keg and a sale with no
 *  stock behind it are different problems with different fixes. */
interface PhantomAlert {
  exportTransactionId: string;
  recipeId: string;
  beerName: string;
  origin: "draft_swap" | "keg_sale" | "can_sale" | null;
  /** Container type the row was booked against — matching is scoped to it. */
  containerType: string | null;
  /** Draft swaps only. */
  tapNumber: number | null;
  variationId: string;
  variationName: string;
  quantityKegs: number;
  volumeBbl: number;
  exciseUsd: number;
  occurredAt: string;
  eligibleLots: PhantomEligibleLot[];
  /** Same container type, but cannot resolve the row — and why. */
  alternativeLots: {
    variationName: string;
    batchCode: string;
    onHand: number;
    reason: "different_size" | "not_enough";
  }[];
  /** Wrong-shape lots that could be broken down into what was booked. Proposals
   *  only — a transform destroys stock, so it is always a click, never a
   *  consequence of resolving. */
  transforms: PhantomTransformOption[];
}

/** A proposed break-down that would produce the booked variation. */
interface PhantomTransformOption {
  lotId: string;
  fromVariationName: string;
  fromUnits: number;
  toVariationName: string;
  toUnits: number;
  batchCode: string;
  shrinkageFlOz: number;
  lossless: boolean;
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

// ── Phantom-export alerts ────────────────────────────────────────────────────
// Taproom draft-restock swaps that booked barrel excise with no cold-storage
// stock to deduct. Mirrors Finance's DataQualityPanel "⚑ N to review" idiom:
// hidden behind a compact indicator, "all reconciled" when nothing's open.

function usePhantomAlertMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: queryKeys.production.phantomAlerts() });
    qc.invalidateQueries({ queryKey: queryKeys.production.exportBayInventory() });
  };

  const reconcile = useMutation({
    mutationFn: async (vars:
      | { exportTransactionId: string; variationId: string; batchId: string }
      | { exportTransactionId: string; transformLotId: string }) => {
      const res = await fetch("/api/production/taproom-consumption/reconcile-phantom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(vars),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Error");
    },
    onSuccess: invalidate,
  });

  const dismiss = useMutation({
    mutationFn: async (vars: { exportTransactionId: string }) => {
      const res = await fetch("/api/production/taproom-consumption/dismiss-phantom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(vars),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Error");
    },
    onSuccess: invalidate,
  });

  return { reconcile, dismiss };
}

function PhantomAlertRow({
  alert,
  selectedLotKey,
  onSelectLot,
  onResolve,
  onDismiss,
  resolving,
  dismissing,
}: {
  alert: PhantomAlert;
  selectedLotKey: string;
  onSelectLot: (lotKey: string) => void;
  onResolve: () => void;
  onDismiss: () => void;
  resolving: boolean;
  dismissing: boolean;
}) {
  const hasLots = alert.eligibleLots.length > 0;
  const hasTransforms = alert.transforms.length > 0;
  const hasOptions = hasLots || hasTransforms;
  // A transform is selected — the button has to say so, because clicking it
  // breaks stock apart irreversibly before it resolves anything.
  const transformSelected = selectedLotKey.startsWith("t|");

  // Why Resolve is unavailable, in the operator's terms. An empty picker said
  // nothing at all — "no matching stock" and "no stock of any kind" look the
  // same from an absent dropdown, and only the first is fixed by moving stock.
  const blockedReason = hasOptions
    ? null
    : alert.alternativeLots.length === 0
      ? `No ${alert.containerType ?? "matching"} stock of ${alert.beerName} is in cold storage at all.`
      : `Needs ${alert.quantityKegs} × ${alert.variationName}. Cold storage holds ` +
        alert.alternativeLots
          .map((l) => `${l.onHand} × ${l.variationName}${l.batchCode ? ` (${l.batchCode})` : ""}`)
          .join(", ") +
        ".";

  return (
    <Card padding="p-3" className="flex items-center justify-between gap-3">
      <div className="flex flex-col gap-1 min-w-0 flex-1">
        <span className="text-sm font-medium text-primary">
          {alert.beerName}
          {alert.tapNumber != null && <span className="text-muted font-normal"> · Tap {alert.tapNumber}</span>}
        </span>
        {/* Unit-neutral: "5 kegs" was rendered for a can 4-pack sale, because
            every phantom was assumed to be a keg swap. */}
        <span className="text-xs text-muted">
          {fmtDate(alert.occurredAt)} · {alert.quantityKegs} × {alert.variationName} · {alert.volumeBbl.toFixed(2)} BBL
        </span>
        {blockedReason && <span className="text-xs text-accent">{blockedReason}</span>}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {hasOptions && (
          // Width is pinned. A native select sizes itself to its WIDEST option,
          // and a break-down option names two variations, two counts, a batch
          // and its loss — long enough to eat the whole row and wrap the alert's
          // own text to one word per line. The browser elides the overflow.
          <select
            className="inp-sm w-56 shrink-0"
            value={selectedLotKey}
            onChange={(e) => onSelectLot(e.target.value)}
          >
            <option value="">— pick lot —</option>
            {alert.eligibleLots.map((lot) => (
              <option key={`${lot.variationId}|${lot.batchId}`} value={`${lot.variationId}|${lot.batchId}`}>
                {lot.variationName} · {lot.batchCode} ({lot.onHand} on hand)
              </option>
            ))}
            {/* Break-downs sit below the exact matches and always name the loss,
                so a wrong-shape option is never mistaken for a free one. */}
            {alert.transforms.map((t) => (
              <option key={`t|${t.lotId}`} value={`t|${t.lotId}`}>
                Break {t.fromUnits} × {t.fromVariationName} → {t.toUnits} × {t.toVariationName}
                {t.batchCode ? ` · ${t.batchCode}` : ""}
                {t.lossless ? " (no loss)" : ` (loses ${t.shrinkageFlOz.toFixed(0)} fl oz)`}
              </option>
            ))}
          </select>
        )}
        {/* Always rendered, disabled when nothing matches. A hidden button reads
            as broken; a disabled one with the reason attached teaches the rule —
            reconciliation demands exact matching stock, so the fix is to put the
            right stock in cold storage, not to loosen the match. */}
        <button
          type="button"
          onClick={onResolve}
          disabled={!hasOptions || !selectedLotKey || resolving}
          title={blockedReason ?? undefined}
          className="btn-primary"
        >
          {resolving ? "…" : transformSelected ? "Break down & resolve" : "Resolve"}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          disabled={dismissing}
          className="btn-secondary"
        >
          {dismissing ? "…" : "Dismiss"}
        </button>
      </div>
    </Card>
  );
}

function PhantomAlertsPanel({
  alerts,
  status,
  loadError,
}: {
  alerts: PhantomAlert[];
  status: "pending" | "error" | "success";
  loadError: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [selectedLotByAlert, setSelectedLotByAlert] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const { reconcile, dismiss } = usePhantomAlertMutations();

  // "All reconciled" is a positive claim about the ledger, so it may only be
  // rendered from a query that actually succeeded. Reporting a pending or
  // failed fetch as reconciled is how a tab full of unresolved draft recounts
  // came to sit behind a clean bill of health.
  if (status === "pending") {
    return <span className="text-xs text-faint whitespace-nowrap">⚑ Checking reconciliation…</span>;
  }
  if (status === "error") {
    return (
      <span
        className="text-xs text-danger whitespace-nowrap"
        title={loadError ?? "The reconciliation check could not be loaded."}
      >
        ⚑ Reconciliation status unavailable
      </span>
    );
  }

  if (alerts.length === 0) {
    return <span className="text-xs text-faint whitespace-nowrap">⚑ All reconciled</span>;
  }

  async function handleResolve(alert: PhantomAlert) {
    const lotKey = selectedLotByAlert[alert.exportTransactionId];
    if (!lotKey) return;
    setError(null);
    try {
      if (lotKey.startsWith("t|")) {
        // Only the lot travels. The server re-derives how many units to break
        // and into what — the counts are how much beer gets destroyed.
        await reconcile.mutateAsync({
          exportTransactionId: alert.exportTransactionId,
          transformLotId: lotKey.slice(2),
        });
        return;
      }
      const [variationId, batchId] = lotKey.split("|");
      if (!variationId || !batchId) return;
      await reconcile.mutateAsync({ exportTransactionId: alert.exportTransactionId, variationId, batchId });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    }
  }

  async function handleDismiss(alert: PhantomAlert) {
    setError(null);
    try {
      await dismiss.mutateAsync({ exportTransactionId: alert.exportTransactionId });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    }
  }

  // A drained tap keg and a sale that outran stock are both "excise booked with
  // nothing to deduct", but they are reconciled against different things and by
  // different people, so they are counted and listed apart. Anything the
  // backfill could not classify lands with the sales rather than being passed
  // off as a swap — an unknown origin is not evidence of a tap.
  const swaps = alerts.filter((a) => a.origin === "draft_swap");
  const sales = alerts.filter((a) => a.origin !== "draft_swap");

  function renderGroup(group: PhantomAlert[]) {
    return group.map((alert) => (
      <PhantomAlertRow
        key={alert.exportTransactionId}
        alert={alert}
        selectedLotKey={selectedLotByAlert[alert.exportTransactionId] ?? ""}
        onSelectLot={(lotKey) =>
          setSelectedLotByAlert((prev) => ({ ...prev, [alert.exportTransactionId]: lotKey }))
        }
        onResolve={() => handleResolve(alert)}
        onDismiss={() => handleDismiss(alert)}
        resolving={reconcile.isPending}
        dismissing={dismiss.isPending}
      />
    ));
  }

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="btn-secondary whitespace-nowrap">
        ⚑ {alerts.length} booked without cold-storage stock
        {swaps.length > 0 && sales.length > 0 && (
          <span className="text-muted font-normal"> ({swaps.length} swap{swaps.length !== 1 ? "s" : ""}, {sales.length} sale{sales.length !== 1 ? "s" : ""})</span>
        )}
      </button>
      {open && (
        <Modal title="Booked without cold-storage stock" onClose={() => setOpen(false)} wide>
          <div className="flex flex-col gap-4">
            {error && <p className="text-xs text-danger">{error}</p>}

            {swaps.length > 0 && (
              <section className="flex flex-col gap-2">
                <div className="flex flex-col gap-0.5">
                  <h3 className="text-sm font-medium text-primary">Draft swaps</h3>
                  <p className="text-xs text-muted">
                    A Draft Restock was rung and the keg it drains was not in cold storage.
                  </p>
                </div>
                {renderGroup(swaps)}
              </section>
            )}

            {sales.length > 0 && (
              <section className="flex flex-col gap-2">
                <div className="flex flex-col gap-0.5">
                  <h3 className="text-sm font-medium text-primary">Sold without stock</h3>
                  <p className="text-xs text-muted">
                    A keg or can was sold in Square with no matching cold-storage stock to draw
                    down. These drain no tap — reconcile against the lot the stock actually
                    came from.
                  </p>
                </div>
                {renderGroup(sales)}
              </section>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function ExportBayTab() {
  const qc = useQueryClient();

  // isPending, not isLoading: isLoading is `isPending && isFetching`, so a retry
  // React Query has paused reads as false while there is still no data — the
  // render would fall through to "Nothing to show yet" for a load that never landed.
  const { data: inventory = [], isPending: inventoryPending, error: inventoryError } = useQuery({
    queryKey: queryKeys.production.exportBayInventory(),
    queryFn: () => fetchJson<AvailableInventoryLine[]>("/api/production/export-bay/inventory"),
  });
  const { data: allocations = [], isPending: allocationsPending, error: allocationsError } = useQuery({
    queryKey: queryKeys.production.allocations(),
    queryFn: () => fetchJson<BatchAllocation[]>("/api/production/allocations"),
  });
  const { data: recipes = [] } = useRecipesQuery();
  const { data: partners = [] } = useContractPartnersQuery();
  const {
    data: phantomAlertsData,
    status: phantomAlertsStatus,
    error: phantomAlertsError,
  } = useQuery({
    queryKey: queryKeys.production.phantomAlerts(),
    queryFn: () => fetchJson<{ alerts: PhantomAlert[] }>("/api/production/taproom-consumption/phantom-alerts"),
  });
  const phantomAlerts = phantomAlertsData?.alerts ?? [];

  // Memoized so the search/filter/sort config (useMemo below) keeps a stable dep
  // set — otherwise React Compiler can't preserve its memoization.
  const recipeNameById  = useMemo(() => new Map(recipes.map((r) => [r.id, r.beer_name])), [recipes]);
  const partnerNameById = useMemo(() => new Map(partners.map((p) => [p.id, p.company_name])), [partners]);

  // ── UI state ──────────────────────────────────────────────────────────────────
  const [shipGroup,         setShipGroup]         = useState<CustomerRecipeGroup | null>(null);
  const [showAdHoc,         setShowAdHoc]         = useState(false);
  const [showSync,          setShowSync]          = useState(false);
  const [showTransform,     setShowTransform]     = useState(false);
  const [writeOffAlloc,     setWriteOffAlloc]     = useState<BatchAllocation | null>(null);
  const [expandedFulfilled, setExpandedFulfilled] = useState<Set<string>>(new Set());

  function toggleFulfilled(recipeId: string) {
    setExpandedFulfilled((prev) => {
      const next = new Set(prev);
      if (next.has(recipeId)) next.delete(recipeId);
      else next.add(recipeId);
      return next;
    });
  }

  // ── Group allocations by partner+recipe, then nest under recipe ──────────────

  const recipeGroups = useMemo(() => {
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

    const byRecipe = new Map<string, RecipeAllocationGroup>();
    for (const g of groups.values()) {
      const existing = byRecipe.get(g.recipeId);
      if (existing) {
        existing.partnerGroups.push(g);
      } else {
        byRecipe.set(g.recipeId, { recipeId: g.recipeId, recipeName: g.recipeName, partnerGroups: [g] });
      }
    }
    return byRecipe;
  }, [allocations, partnerNameById, recipeNameById]);

  const inventoryByRecipe = useMemo(() => {
    const byRecipe = new Map<string, AvailableInventoryLine[]>();
    for (const line of inventory) {
      const list = byRecipe.get(line.recipe_id) ?? [];
      list.push(line);
      byRecipe.set(line.recipe_id, list);
    }
    return byRecipe;
  }, [inventory]);

  // ── Chip option derivation ────────────────────────────────────────────────────
  // The shared FilterChips auto-renders the "All" chip, so these derived lists omit it.

  // Channels present in loaded allocations (taproom excluded — it has no allocations panel).
  // Each option carries its channel color via `className` (sanctioned raw-color exception).
  const presentChannels = new Set<string>();
  for (const a of allocations) {
    if (a.channel !== "taproom") presentChannels.add(a.channel);
  }
  const channelChipOptions = ["distribution", "contract_brewing", "wholesale", "safety_stock"]
    .filter((c) => presentChannels.has(c))
    .map((c) => ({
      value: c,
      label: CHANNEL_CHIP_LABELS[c] ?? c,
      className: `${CHANNEL_COLOR[c]?.bg ?? ""} ${CHANNEL_COLOR[c]?.text ?? ""}`.trim(),
    }));

  // Partners present in loaded allocations, sorted alphabetically.
  const seenPartners = new Map<string, string>();
  for (const a of allocations) {
    if (a.partner_id && !seenPartners.has(a.partner_id)) {
      seenPartners.set(
        a.partner_id,
        a.contract_brewing_partners?.company_name ?? partnerNameById.get(a.partner_id) ?? "Unknown"
      );
    }
  }
  const partnerChipOptions = Array.from(seenPartners.entries())
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([id, name]) => ({ value: id, label: name }));

  // Show the channel/partner dimensions only when they add a real choice (>1 option;
  // the "All" chip is auto-rendered on top of these lists).
  const showPartnerChips = partnerChipOptions.length > 1;

  // All recipe ids in view: inventory-bearing ∪ allocation-bearing.
  const allRecipeIds = Array.from(new Set([...inventoryByRecipe.keys(), ...recipeGroups.keys()]));

  // ── Search / filter / sort config ───────────────────────────────────────────────
  // Predicate filters (a recipe matches by whether it HAS an allocation in a given
  // status/channel/partner — not single-value equality) plus signed sort accessors so
  // all three domain sorts run ascending. Expressions lifted verbatim from the former
  // filter().sort() pipeline; accessors close over the recipe maps, hence useMemo.
  const exportControls = useMemo<ControlsConfig<string>>(() => {
    // Earliest unfulfilled due date across a recipe's allocations (null = none).
    const earliestDueDate = (recipeId: string): string | null => {
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
    };
    // Signed urgency key (asc = soonest). A real due-date epoch sorts first; recipes
    // that have allocations but no due date sort after all dated recipes; inventory-only
    // recipes sort last — preserving the former urgencySort's has-allocation tiebreak.
    const earliestDueEpoch = (recipeId: string): number => {
      const iso = earliestDueDate(recipeId);
      if (iso) {
        const t = Date.parse(iso);
        if (!Number.isNaN(t)) return t;
      }
      return recipeGroups.has(recipeId) ? 8.64e15 : 8.64e15 + 1;
    };
    const stockTotal = (recipeId: string): number =>
      (inventoryByRecipe.get(recipeId) ?? []).reduce((s, l) => s + l.quantity_on_hand, 0);

    // Status bucket predicate (pending / fulfilled / inventory_only), lifted verbatim.
    const recipeMatchesStatus = (recipeId: string, s: string): boolean => {
      const rg    = recipeGroups.get(recipeId);
      const lines = inventoryByRecipe.get(recipeId) ?? [];
      if (s === "pending") {
        return rg?.partnerGroups.some((g) => g.allocations.some((a) => !a.fulfilled)) ?? false;
      }
      if (s === "fulfilled") {
        if (!rg) return false;
        return rg.partnerGroups.every((g) => g.allocations.every((a) => a.fulfilled));
      }
      if (s === "inventory_only") {
        return !rg && lines.length > 0;
      }
      return true;
    };
    // Recipe has ≥1 allocation in the selected channel.
    const recipeHasChannel = (recipeId: string, s: string): boolean =>
      recipeGroups.get(recipeId)?.partnerGroups.some((g) => g.allocations.some((a) => a.channel === s)) ?? false;
    // Recipe has ≥1 allocation from the selected partner.
    const recipeHasPartner = (recipeId: string, s: string): boolean =>
      recipeGroups.get(recipeId)?.partnerGroups.some((g) => g.partnerId === s) ?? false;

    return {
      search: [{ param: "q", accessor: (id) => recipeNameById.get(id) ?? "" }],
      filters: [
        { param: "status",  matches: (id, sel) => sel.some((s) => recipeMatchesStatus(id, s)) },
        { param: "channel", matches: (id, sel) => sel.some((s) => recipeHasChannel(id, s)) },
        { param: "partner", matches: (id, sel) => sel.some((s) => recipeHasPartner(id, s)) },
      ],
      sort: {
        columns: [
          { key: "urgency", accessor: (id) => earliestDueEpoch(id) },
          { key: "name",    accessor: (id) => recipeNameById.get(id) ?? "" },
          { key: "stock",   accessor: (id) => -stockTotal(id) },
        ],
        default: { key: "urgency", dir: "asc" },
      },
    };
  }, [recipeNameById, recipeGroups, inventoryByRecipe]);

  // prefix the URL params: this tab shares /production/export with sibling tabs
  // (Shipments, Export Invoices) that PR 2 will retrofit — avoid param collisions.
  const { rows: filteredRecipeIds, search, filters, sort, setSearch, setFilter, setSort, reset, activeCount } =
    useTableControls(allRecipeIds, exportControls, { prefix: "bay_" });

  const anyData = inventory.length > 0 || recipeGroups.size > 0;

  if (inventoryPending || allocationsPending) {
    return <p className="text-sm text-faint py-8 text-center">Loading…</p>;
  }

  const bayError = inventoryError ?? allocationsError;
  if (bayError) {
    return (
      <p className="text-sm text-danger py-8 text-center">
        Could not load the export bay: {bayError instanceof Error ? bayError.message : "unknown error"}
      </p>
    );
  }

  function afterShip() {
    qc.invalidateQueries({ queryKey: queryKeys.production.exportBayInventory() });
    qc.invalidateQueries({ queryKey: queryKeys.production.allocations() });
    setShipGroup(null);
  }

  async function undoWriteOff(a: BatchAllocation) {
    if (!window.confirm("Reopen this allocation? It will no longer count as fulfilled.")) return;
    try {
      const res = await fetch(`/api/production/allocations/${a.id}/write-off`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Error");
      qc.invalidateQueries({ queryKey: queryKeys.production.allocations() });
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Failed to reverse write-off");
    }
  }

  return (
    <div className="space-y-3">

      {/* Actions */}
      <div className="flex items-center justify-between gap-2">
        <PhantomAlertsPanel
          alerts={phantomAlerts}
          status={phantomAlertsStatus}
          loadError={phantomAlertsError instanceof Error ? phantomAlertsError.message : null}
        />
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowSync(true)}
            title="Reconcile taproom pours from Square into cold-storage draws"
            className="btn-secondary"
          >
            ↻ Sync Taproom
          </button>
          <button
            onClick={() => setShowTransform(true)}
            title="Repackage cold-storage stock into a different size — a 1/2 keg into sixtels, or sixtels into a 1/2 keg"
            className="btn-secondary"
          >
            ⇄ Transform Stock
          </button>
          <button
            onClick={() => setShowAdHoc(true)}
            disabled={inventory.length === 0}
            title={inventory.length === 0 ? "No packaged inventory available" : undefined}
            className="btn-primary"
          >
            + Ad-Hoc Export
          </button>
        </div>
      </div>

      {/* Search + filter + sort */}
      <FilterBar activeCount={activeCount} onClear={reset}>
        <SearchInput
          value={search.q ?? ""}
          onChange={(v) => setSearch("q", v)}
          placeholder="Search recipes…"
        />
        <FilterChips
          label="Status"
          options={[
            { value: "pending",        label: "Pending"    },
            { value: "fulfilled",      label: "Fulfilled"  },
            { value: "inventory_only", label: "Stock only" },
          ]}
          value={filters.status ?? []}
          onChange={(v) => setFilter("status", v)}
        />
        {channelChipOptions.length > 1 && (
          <FilterChips
            label="Channel"
            options={channelChipOptions}
            value={filters.channel ?? []}
            onChange={(v) => setFilter("channel", v)}
          />
        )}
        {showPartnerChips && (
          <FilterChips
            label="Partner"
            options={partnerChipOptions}
            value={filters.partner ?? []}
            onChange={(v) => setFilter("partner", v)}
          />
        )}
        {/* Segmented domain sort — Export Bay renders card groups, not a column
            table, so the sort is a single-select FilterChips (documented one-off). */}
        <FilterChips
          label="Sort"
          options={[
            { value: "urgency", label: "Urgency" },
            { value: "name",    label: "A–Z"     },
            { value: "stock",   label: "Stock"   },
          ]}
          value={sort ? [sort.key] : ["urgency"]}
          onChange={(v) => setSort(v[0] ?? "urgency", "asc")}
        />
      </FilterBar>

      {/* Result count */}
      {activeCount > 0 && (
        <span className="text-xs text-muted">
          {filteredRecipeIds.length} of {allRecipeIds.length} recipe{allRecipeIds.length !== 1 ? "s" : ""}
        </span>
      )}

      {/* Sticky column labels */}
      <div className="sticky top-0 z-10 bg-canvas grid grid-cols-1 md:grid-cols-2 gap-6 py-2 border-b border-line/60">
        <h3 className="text-sm font-medium text-body">Available</h3>
        <h3 className="text-sm font-medium text-body">Allocations</h3>
      </div>

      {!anyData ? (
        <p className="text-sm text-faint pt-2">Nothing to show yet.</p>
      ) : filteredRecipeIds.length === 0 ? (
        <p className="text-sm text-faint pt-2">No recipes match the current filters.</p>
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
                  <span className="text-sm font-medium text-strong">{recipeName}</span>
                  <div className="flex items-center gap-2 text-xs">
                    {rg ? (
                      <>
                        {pendingCount > 0 && (
                          <span className="text-accent">{pendingCount} pending</span>
                        )}
                        {pendingCount > 0 && fulfilledCount > 0 && (
                          <span className="text-disabled">·</span>
                        )}
                        {fulfilledCount > 0 && (
                          <span className="text-faint">{fulfilledCount} fulfilled</span>
                        )}
                      </>
                    ) : (
                      <span className="text-faint">no allocations</span>
                    )}
                    {hasInventory && (
                      <>
                        <span className="text-disabled">·</span>
                        <span className="text-muted">{stockSummary(lines)} in stock</span>
                      </>
                    )}
                  </div>
                </div>

                {/* Two-card row */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-stretch">

                  {/* Left: Available (inventory) */}
                  <div className={`rounded-lg border overflow-hidden flex flex-col ${
                    !hasInventory ? "border-dashed border-line-strong" : "border-line"
                  }`}>
                    <div className="px-3 py-2 bg-surface/60 border-b border-line flex items-center justify-between">
                      <span className="text-xs font-medium text-muted uppercase tracking-wide">In Stock</span>
                      {hasInventory && (
                        <span className="text-xs text-secondary">{stockSummary(lines)}</span>
                      )}
                    </div>
                    {!hasInventory ? (
                      <div className="px-3 py-3 text-xs text-faint italic flex-1">
                        No inventory available
                      </div>
                    ) : (
                      <div className="divide-y divide-line flex-1">
                        {[...lines].sort((a, b) => {
                          const t = (a.container_type === "keg" ? 0 : 1) - (b.container_type === "keg" ? 0 : 1);
                          return t !== 0 ? t : a.variation_name.localeCompare(b.variation_name);
                        }).map((l) => (
                          <div key={l.variation_id} className="flex items-center justify-between px-3 py-2 text-sm gap-2">
                            <div className="flex items-center gap-1.5 min-w-0">
                              {l.container_type === "keg" ? (
                                <span className={`text-[10px] px-1.5 py-0.5 rounded ${KEG_TAG_BADGE} font-medium uppercase shrink-0`}>Keg</span>
                              ) : l.container_type === "can" ? (
                                <span className="text-[10px] px-1.5 py-0.5 rounded border border-info-border bg-info-surface/30 text-info font-medium uppercase shrink-0">Can</span>
                              ) : null}
                              <span className="text-body truncate">{l.variation_name}</span>
                            </div>
                            <span className="text-secondary tabular-nums shrink-0">{l.quantity_on_hand}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Right: Allocations */}
                  <div className="rounded-lg border border-line overflow-hidden flex flex-col">
                    {!rg ? (
                      <div className="px-3 py-3 text-xs text-faint italic flex-1">
                        No active allocations
                      </div>
                    ) : (
                      <div className="divide-y divide-line/60 flex-1">
                        {visiblePartnerGroups.length === 0 ? (
                          <div className="px-3 py-3 text-xs text-faint italic">
                            All allocations fulfilled
                          </div>
                        ) : (
                          visiblePartnerGroups.map((g) => (
                            <div key={g.partnerId}>
                              <div className="flex items-center justify-between px-3 py-1.5 bg-surface/30">
                                <span className="text-xs font-medium text-secondary">{g.partnerName}</span>
                                <button
                                  onClick={() => setShipGroup(g)}
                                  disabled={!hasInventory}
                                  title={hasInventory ? undefined : "No packaged inventory available for this recipe"}
                                  className="btn-primary"
                                >
                                  Ship
                                </button>
                              </div>
                              <div className="divide-y divide-line">
                                {g.allocations.map((a) => (
                                  <div key={a.id} className="flex items-center justify-between px-3 py-2 text-sm gap-2">
                                    <div className="flex items-center gap-2 min-w-0">
                                      <ChannelBadge channel={a.channel} />
                                      <span className="text-secondary font-mono text-xs shrink-0">
                                        {a.brew_batches ? `#${a.brew_batches.batch_number}` : "—"}
                                      </span>
                                      {a.deposit_backed && a.under_covered && (
                                        <span className="text-[10px] px-1 py-px rounded border border-danger-border bg-danger-surface/40 text-danger shrink-0">
                                          under-covered
                                        </span>
                                      )}
                                      <span className="text-muted text-xs truncate">
                                        Due {fmtDate(a.commitments?.desired_delivery_date ?? null)}
                                      </span>
                                    </div>
                                    <div className="flex flex-col items-end gap-0.5 shrink-0">
                                      <span className="text-secondary tabular-nums text-xs">
                                        {a.exported_bbl.toFixed(2)} / {allocDenomBbl(a) != null ? allocDenomBbl(a)!.toFixed(2) : "—"} BBL
                                        <span className="text-faint ml-1">{a.deposit_backed ? "booked" : "plan"}</span>
                                      </span>
                                      {a.deposit_backed && a.final_entitlement_bbl == null && (
                                        <span className="text-[10px] text-faint tabular-nums">≈ {a.realizable_bbl.toFixed(2)} so far</span>
                                      )}
                                      {a.deposit_backed && a.final_entitlement_bbl != null && (
                                        <span className="text-[10px] text-faint tabular-nums">
                                          final {a.final_entitlement_bbl.toFixed(2)}
                                          {a.under_delivered_bbl != null && a.under_delivered_bbl > 0 && (
                                            <span className="text-accent-soft"> · owed {a.under_delivered_bbl.toFixed(2)}</span>
                                          )}
                                          {a.over_delivered_bbl != null && a.over_delivered_bbl > 0 && (
                                            <span className="text-danger"> · over {a.over_delivered_bbl.toFixed(2)}</span>
                                          )}
                                        </span>
                                      )}
                                      {a.written_off_at ? (
                                        <div className="flex items-center gap-2">
                                          <span className="text-xs text-secondary">
                                            Written off{a.written_off_bbl && a.written_off_bbl > 0.001 ? ` · ${a.written_off_bbl.toFixed(2)} BBL` : ""}
                                          </span>
                                          <button
                                            type="button"
                                            onClick={() => undoWriteOff(a)}
                                            className="btn-secondary btn-xxs"
                                          >
                                            Undo
                                          </button>
                                        </div>
                                      ) : allocDenomBbl(a) == null ? (
                                        <span className="text-xs text-faint">Pending production</span>
                                      ) : a.fulfilled ? (
                                        <span className="text-xs text-success">Fulfilled</span>
                                      ) : (
                                        <div className="flex items-center gap-2">
                                          <span className="text-xs text-accent">
                                            {`${Math.min(100, (a.exported_bbl / allocDenomBbl(a)!) * 100).toFixed(0)}%`}
                                          </span>
                                          <button
                                            type="button"
                                            onClick={() => setWriteOffAlloc(a)}
                                            title="Forgive the remaining owed volume and mark this allocation fulfilled"
                                            className="btn-secondary btn-xxs"
                                          >
                                            Write off
                                          </button>
                                        </div>
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
                              className="btn-secondary"
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

      {showSync && (
        <SyncConsumptionModal
          onClose={() => setShowSync(false)}
          onRecorded={() => qc.invalidateQueries({ queryKey: queryKeys.production.exportBayInventory() })}
        />
      )}

      {showTransform && (
        <ColdStorageTransformModal
          onClose={() => setShowTransform(false)}
          onDone={() => {
            // Both views of cold storage move: the per-batch lots the modal picks
            // from, and the recipe-level availability this tab ships against.
            qc.invalidateQueries({ queryKey: queryKeys.production.coldStorage() });
            qc.invalidateQueries({ queryKey: queryKeys.production.exportBayInventory() });
            qc.invalidateQueries({ queryKey: queryKeys.production.coldStorageAdjustments() });
            setShowTransform(false);
          }}
        />
      )}

      {writeOffAlloc && (
        <WriteOffModal
          alloc={writeOffAlloc}
          partnerName={writeOffAlloc.partner_id ? (partnerNameById.get(writeOffAlloc.partner_id) ?? "") : ""}
          recipeName={writeOffAlloc.brew_batches?.recipe_id ? (recipeNameById.get(writeOffAlloc.brew_batches.recipe_id) ?? "") : ""}
          onClose={() => setWriteOffAlloc(null)}
          onDone={() => {
            qc.invalidateQueries({ queryKey: queryKeys.production.allocations() });
            setWriteOffAlloc(null);
          }}
        />
      )}
    </div>
  );
}

// ── WriteOffModal ────────────────────────────────────────────────────────────────

function WriteOffModal({ alloc, partnerName, recipeName, onClose, onDone }: {
  alloc: BatchAllocation;
  partnerName: string;
  recipeName: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [note,       setNote]       = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error,      setError]      = useState<string | null>(null);

  // Same pure assessment the server runs — remaining owed + tolerance verdict.
  const assessment = assessWriteOff({
    depositBacked:       alloc.deposit_backed,
    bookedBbl:           alloc.booked_bbl,
    finalEntitlementBbl: alloc.final_entitlement_bbl,
    realizableBbl:       alloc.realizable_bbl,
    exportedBbl:         alloc.exported_bbl,
  });
  const pctForgiven = Math.round(assessment.fraction * 100);
  const pctWarn     = Math.round(assessment.warnFraction * 100);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch(`/api/production/allocations/${alloc.id}/write-off`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: note || null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Error");
      onDone();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-surface border border-line-strong rounded-lg p-5 w-full max-w-md space-y-4">
        <div>
          <h3 className="text-sm font-medium text-primary">Write off remaining allocation</h3>
          <p className="text-xs text-muted mt-1">
            {[partnerName, recipeName, alloc.brew_batches ? `#${alloc.brew_batches.batch_number}` : null]
              .filter(Boolean).join(" · ")}
          </p>
        </div>

        <div className="rounded border border-line px-3 py-2 space-y-1 text-xs">
          <div className="flex justify-between">
            <span className="text-muted">Delivered</span>
            <span className="text-secondary tabular-nums">{assessment.exportedBbl.toFixed(2)} BBL</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted">{alloc.deposit_backed ? "Owed (entitlement)" : "Planned share"}</span>
            <span className="text-secondary tabular-nums">{assessment.entitlementBbl.toFixed(2)} BBL</span>
          </div>
          <div className="flex justify-between font-medium">
            <span className="text-body">To write off</span>
            <span className="text-strong tabular-nums">{assessment.remainingBbl.toFixed(2)} BBL</span>
          </div>
        </div>

        {assessment.fullyDelivered ? (
          <p className="text-xs text-muted">
            Nothing is owed on this allocation — writing it off simply marks it fulfilled.
          </p>
        ) : assessment.exceedsTolerance ? (
          <div className="rounded border border-danger-border bg-danger-surface/30 px-3 py-2">
            <p className="text-xs text-danger">
              You&apos;re forgiving {assessment.remainingBbl.toFixed(2)} BBL — {pctForgiven}% of the entitlement,
              above the {pctWarn}% tolerance. Confirm this is intended before writing it off.
            </p>
          </div>
        ) : (
          <p className="text-xs text-muted">
            Forgiving {assessment.remainingBbl.toFixed(2)} BBL ({pctForgiven}% of the entitlement). No refund is
            issued — this just closes the allocation as fulfilled.
          </p>
        )}

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="text-xs text-secondary block mb-1">Note (optional)</label>
            <input className="inp w-full" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Reason for the write-off" />
          </div>
          {error && <p className="text-xs text-danger">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
            <button
              type="submit"
              disabled={submitting}
              className={assessment.exceedsTolerance ? "btn-danger" : "btn-primary"}
            >
              {submitting ? "Writing off…" : "Write off"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── SyncConsumptionModal ─────────────────────────────────────────────────────────

interface SyncDiscrepancy {
  kind: "unconfigured_draft_swap" | "short_stock" | "dead_square_link";
  recipeId: string;
  beerName?: string;
  swapCount?: number;
  variationId?: string;
  label?: string;
  requestedQty?: number;
  recordedQty?: number;
  shortfallQty?: number;
  squareVariationId?: string;
  packaging?: string;
  itemName?: string | null;
  variationName?: string | null;
  reason?: "deleted_in_square" | "missing_from_catalog";
}

interface SyncResult {
  windowDays: number;
  recorded: { kind: string; label: string; recordedQty: number }[];
  recordedUnits: number;
  unitsExamined: number;
  alreadyRecorded: number;
  bookedNothing: number;
  totalRecordedQty: number;
  discrepancies: SyncDiscrepancy[];
}

function SyncConsumptionModal({ onClose, onRecorded }: { onClose: () => void; onRecorded: () => void }) {
  const [days,      setDays]      = useState("2");
  const [running,   setRunning]   = useState(false);
  const [error,     setError]     = useState<string | null>(null);
  const [result,    setResult]    = useState<SyncResult | null>(null);

  async function run() {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch(`/api/production/taproom-consumption/sync?days=${encodeURIComponent(days || "2")}`, {
        method: "POST",
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Error");
      const data: SyncResult = await res.json();
      setResult(data);
      if (data.recordedUnits > 0) onRecorded();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setRunning(false);
    }
  }

  const configDiscs = result?.discrepancies.filter((d) => d.kind === "unconfigured_draft_swap") ?? [];
  const shortDiscs  = result?.discrepancies.filter((d) => d.kind === "short_stock") ?? [];
  const deadDiscs   = result?.discrepancies.filter((d) => d.kind === "dead_square_link") ?? [];

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-surface border border-line-strong rounded-lg p-5 w-full max-w-lg space-y-4">
        <div>
          <h3 className="text-sm font-medium text-primary">Sync Taproom Consumption</h3>
          <p className="text-xs text-muted mt-1">
            Reconciles keg/can sales and draft keg-swaps from Square into taproom shipments that
            drain cold storage. Safe to re-run — only unrecorded activity is booked.
          </p>
        </div>

        <div className="flex items-end gap-2">
          <div>
            <label className="text-xs text-secondary block mb-1">Look-back (days)</label>
            <input
              type="number" min="1" max="120" className="inp-sm w-24"
              value={days} onChange={(e) => setDays(e.target.value)}
            />
          </div>
          <button onClick={run} disabled={running} className="btn-primary">
            {running ? "Syncing…" : "Run sync"}
          </button>
        </div>

        {error && <p className="text-xs text-danger">{error}</p>}

        {result && (
          <div className="space-y-3 text-xs">
            <div className="rounded border border-line px-3 py-2 text-secondary">
              Examined <span className="text-strong tabular-nums">{result.unitsExamined}</span> unit
              {result.unitsExamined !== 1 ? "s" : ""} over the last {result.windowDays}d
              {" · "}recorded <span className="text-strong tabular-nums">{result.recordedUnits}</span>
              {" "}(<span className="text-strong tabular-nums">{result.totalRecordedQty}</span> total)
              {" · "}<span className="tabular-nums">{result.alreadyRecorded}</span> already up to date
            </div>

            {/*
              A unit the run tried to book and got nothing for. Previously counted
              into the same "already up to date" figure as a genuine no-op, which
              made a run that booked nothing indistinguishable from a clean one.
            */}
            {result.bookedNothing > 0 && (
              <p className="text-danger">
                <span className="tabular-nums">{result.bookedNothing}</span> unit
                {result.bookedNothing !== 1 ? "s" : ""} had something owed and booked nothing.
              </p>
            )}

            {configDiscs.length > 0 && (
              <div>
                <p className="text-secondary font-medium mb-1">Draft swap inventory not configured</p>
                <ul className="space-y-1">
                  {configDiscs.map((d) => (
                    <li key={d.recipeId} className="text-muted">
                      {d.beerName ?? d.recipeId} — {d.swapCount} swap{d.swapCount !== 1 ? "s" : ""} not recorded.
                      Set its swap keg in Draft Stats.
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {shortDiscs.length > 0 && (
              <div>
                <p className="text-secondary font-medium mb-1">Insufficient cold storage</p>
                <ul className="space-y-1">
                  {shortDiscs.map((d, i) => (
                    <li key={`${d.variationId}-${i}`} className="text-muted">
                      {d.label} — recorded {d.recordedQty}, {d.shortfallQty} short. Check the missing kegging entry.
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/*
              Listed first and in the danger colour: a mapping pointing at a
              variation Square no longer has takes its beer out of this sync's
              sight entirely, so every other figure above is measured over an
              incomplete population until it is repaired.
            */}
            {deadDiscs.length > 0 && (
              <div>
                <p className="text-danger font-medium mb-1">Mapping points at a deleted Square variation</p>
                <ul className="space-y-1">
                  {deadDiscs.map((d) => (
                    <li key={d.squareVariationId} className="text-muted">
                      {d.itemName ?? d.recipeId}{d.variationName ? ` · ${d.variationName}` : ""} ({d.packaging ?? ""})
                      {" — "}
                      {d.reason === "deleted_in_square"
                        ? "deleted in Square. Its sales book nothing until it is re-mapped."
                        : "not in the catalog mirror. Run the Square catalog sync, then re-map it if it is still missing."}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {result.discrepancies.length === 0 && (
              <p className="text-success">No discrepancies.</p>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="btn-secondary">
            {result ? "Done" : "Cancel"}
          </button>
        </div>
      </div>
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
  // Several packaging variations of the same recipe can ship together against
  // one allocation — e.g. 2× 1/2 keg and 3× 1/6 keg of the same beer.
  const [shipLines, setShipLines] = useState<{ variation_id: string; quantity: string }[]>(
    [{ variation_id: inventoryLines[0]?.variation_id ?? "", quantity: "" }]
  );
  const [notes,       setNotes]       = useState("");
  const [submitting,  setSubmitting]  = useState(false);
  const [error,       setError]       = useState<string | null>(null);
  const [warnings,    setWarnings]    = useState<ShipmentWarning[]>([]);
  const [preview,     setPreview]     = useState<{
    warnings: ShipmentWarning[];
    insufficientStock: boolean;
    available: number;
    lines?: { variation_id: string; requested: number; available: number; insufficient: boolean }[];
  } | null>(null);

  // Only complete lines are worth previewing or submitting.
  const filledLines = shipLines
    .map((l) => ({ variation_id: l.variation_id, quantity: parseFloat(l.quantity) }))
    .filter((l) => l.variation_id && Number.isFinite(l.quantity) && l.quantity > 0);
  // Serialized so the effect re-runs on content change, not identity change.
  const linesKey = JSON.stringify(filledLines);

  // Live advisory preview: ask the server what warnings this shipment would raise
  // (coverage / over-booking / under-production) before the user commits.
  useEffect(() => {
    const lines = JSON.parse(linesKey) as { variation_id: string; quantity: number }[];
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      if (lines.length === 0) { setPreview(null); return; }
      try {
        const res = await fetch("/api/production/export-bay/ship/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: ctrl.signal,
          body: JSON.stringify({ partner_id: group.partnerId, recipe_id: group.recipeId, lines }),
        });
        if (res.ok) setPreview(await res.json());
      } catch { /* aborted / network — advisory only, ignore */ }
    }, 400);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [linesKey, group.partnerId, group.recipeId]);

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
          recipe_id:  group.recipeId,
          lines:      filledLines,
          notes:      notes || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Error");
      // Shipment succeeds; if it raised advisory warnings, show them and let the
      // user acknowledge before closing instead of silently completing.
      const ws: ShipmentWarning[] = Array.isArray(data.warnings) ? data.warnings : [];
      if (ws.length > 0) setWarnings(ws);
      else onDone();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-surface border border-line-strong rounded-lg p-5 w-full max-w-md space-y-4">
        <h3 className="text-sm font-medium text-primary">
          Ship to {group.partnerName} — {group.recipeName}
        </h3>
        {warnings.length > 0 ? (
          <div className="space-y-4">
            <div className="rounded border border-accent-border bg-accent-muted/30 px-3 py-2 space-y-1.5">
              <p className="text-xs font-medium text-accent-soft">Shipped — with advisories</p>
              <ul className="space-y-1">
                {warnings.map((w, i) => (
                  <li key={i} className="text-xs text-secondary">{formatShipmentWarning(w)}</li>
                ))}
              </ul>
            </div>
            <div className="flex justify-end pt-1">
              <button type="button" onClick={onDone} className="btn-primary">Done</button>
            </div>
          </div>
        ) : (
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs text-secondary">Packaging</label>
              <button type="button" className="btn-secondary"
                onClick={() => setShipLines((ls) => [...ls, { variation_id: "", quantity: "" }])}>
                + Add line
              </button>
            </div>
            <div className="space-y-2">
              {shipLines.map((line, i) => {
                const linePreview = preview?.lines?.find((p) => p.variation_id === line.variation_id);
                return (
                  <div key={i}>
                    <div className="grid items-center gap-2" style={{ gridTemplateColumns: "1fr 72px auto" }}>
                      <select className="inp-sm" value={line.variation_id}
                        onChange={(e) => setShipLines((ls) => ls.map((l, idx) => idx === i ? { ...l, variation_id: e.target.value } : l))}>
                        <option value="">— select —</option>
                        {inventoryLines.map((l) => (
                          <option key={l.variation_id} value={l.variation_id}>
                            {l.variation_name} ({l.quantity_on_hand} available)
                          </option>
                        ))}
                      </select>
                      <input type="number" min="0" step="1" className="inp-sm" placeholder="qty"
                        value={line.quantity}
                        onChange={(e) => setShipLines((ls) => ls.map((l, idx) => idx === i ? { ...l, quantity: e.target.value } : l))} />
                      {shipLines.length > 1
                        ? <button type="button" className="btn-danger btn-xxs"
                            onClick={() => setShipLines((ls) => ls.filter((_, idx) => idx !== i))}>×</button>
                        : <span />}
                    </div>
                    {linePreview?.insufficient && (
                      <p className="text-xs text-danger mt-1">
                        Only {linePreview.available} available — reduce this line.
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
            <p className="text-xs text-muted mt-2">
              Total units: {filledLines.reduce((s, l) => s + l.quantity, 0)}
            </p>
          </div>
          <div>
            <label className="text-xs text-secondary block mb-1">Notes</label>
            <input className="inp w-full" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          {preview && preview.warnings.length > 0 && (
            <div className="rounded border border-accent-border bg-accent-muted/30 px-3 py-2 space-y-1">
              <p className="text-xs font-medium text-accent-soft">Heads up</p>
              <ul className="space-y-0.5">
                {preview.warnings.map((w, i) => (
                  <li key={i} className="text-xs text-secondary">{formatShipmentWarning(w)}</li>
                ))}
              </ul>
            </div>
          )}
          {error && <p className="text-xs text-danger">{error}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
            <button
              type="submit"
              disabled={submitting || inventoryLines.length === 0 || filledLines.length === 0 || preview?.insufficientStock}
              className="btn-primary"
            >
              {submitting ? "Shipping…" : "Ship"}
            </button>
          </div>
        </form>
        )}
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
      <div className="bg-surface border border-line-strong rounded-lg p-5 w-full max-w-md space-y-4">
        <h3 className="text-sm font-medium text-primary">Ad-Hoc Export</h3>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="text-xs text-secondary block mb-1">Channel</label>
            <select className="inp w-full" value={channel} onChange={(e) => setChannel(e.target.value as ExportChannel)}>
              <option value="taproom">Taproom</option>
              <option value="distribution">Distribution</option>
              <option value="contract_brewing">Contract Brewing</option>
              <option value="wholesale">Wholesale</option>
            </select>
          </div>
          {channel !== "taproom" && (
            <div>
              <label className="text-xs text-secondary block mb-1">Partner</label>
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
              <label className="text-xs text-secondary block mb-1">Recipient name (optional)</label>
              <input className="inp w-full" value={recipientName} onChange={(e) => setRecipientName(e.target.value)} />
            </div>
          )}
          <div>
            <label className="text-xs text-secondary block mb-1">Recipe</label>
            <select className="inp w-full" value={recipeId} onChange={(e) => handleSelectRecipe(e.target.value)}>
              {recipeIds.map((id) => (
                <option key={id} value={id}>{recipeNameById.get(id) ?? "Unknown recipe"}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-secondary block mb-1">Packaging</label>
            <select className="inp w-full" value={variationId} onChange={(e) => setVariationId(e.target.value)}>
              {linesForRecipe.map((l) => (
                <option key={l.variation_id} value={l.variation_id}>
                  {l.variation_name} ({l.quantity_on_hand} available)
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-secondary block mb-1">Quantity</label>
            <input type="number" min="0" step="1" className="inp w-full" required value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          </div>
          <div>
            <label className="text-xs text-secondary block mb-1">Notes</label>
            <input className="inp w-full" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          {error && <p className="text-xs text-danger">{error}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
            <button
              type="submit"
              disabled={submitting || linesForRecipe.length === 0}
              className="btn-primary"
            >
              {submitting ? "Shipping…" : "Ship"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
