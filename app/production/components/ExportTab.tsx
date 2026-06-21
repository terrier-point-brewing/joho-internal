"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRecipesQuery, fetchJson } from "../hooks/queries";
import { SquareLinkManager, LinkRow } from "./SquareLinkManager";
import type { BatchAllocation, AllocationChannel, Recipe } from "../types";
import { queryKeys } from "@/lib/query-keys";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ExportChannel = "taproom" | "distribution" | "contract_brewing";

interface ExportTransactionRow {
  id: string;
  batch_id: string;
  channel: ExportChannel;
  recipient_id: string | null;
  recipient_name: string | null;
  /** Packaging variant label, e.g. "1/6 Keg" or "Case (24ct)". */
  variant_label: string;
  quantity: number;
  volume_bbl: number;
  notes: string | null;
  /** Total excise tax (USD) across all applicable rates, persisted at export time. */
  total_excise_tax_usd: number;
  status: "invoice_required" | "unpaid" | "paid";
  created_at: string;
  brew_batches: { id: string; beer_name: string; batch_number: number } | null;
}

type TopTab = "allocations" | ExportChannel;

const TOP_TABS: { key: TopTab; label: string }[] = [
  { key: "allocations", label: "Allocations" },
  { key: "taproom", label: "Taproom" },
  { key: "distribution", label: "Distribution" },
  { key: "contract_brewing", label: "Contract Brewing" },
];

const CHANNEL_TABS: { key: ExportChannel; label: string; description: string }[] = [
  {
    key: "taproom",
    label: "Taproom",
    description: "Product pushed to taproom inventory. Will sync with Square API to update item stock at the taproom location.",
  },
  {
    key: "distribution",
    label: "Distribution",
    description: "Product shipped to distribution partners for retail/wholesale.",
  },
  {
    key: "contract_brewing",
    label: "Contract Brewing",
    description: "Product delivered to contract brewing clients.",
  },
];

const BBL_TO_GAL = 31;

const CHANNEL_LABELS: Record<AllocationChannel, string> = {
  taproom: "Taproom",
  distribution: "Distribution",
  contract_brewing: "Contract Brewing",
  safety_stock: "Safety Stock",
  conversion: "Conversion",
};

function fmt(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// ─── Allocations Tab ─────────────────────────────────────────────────────────

function AllocationsTab() {
  const { data: allocations = [], isLoading } = useQuery({
    queryKey: queryKeys.production.allocations(),
    queryFn: () => fetchJson<BatchAllocation[]>("/api/production/allocations"),
  });

  if (isLoading) return <p className="text-sm text-zinc-600 py-8 text-center">Loading…</p>;

  // Group by batch
  const byBatch = new Map<string, BatchAllocation[]>();
  for (const a of allocations) {
    const list = byBatch.get(a.batch_id) ?? [];
    list.push(a);
    byBatch.set(a.batch_id, list);
  }

  if (byBatch.size === 0) {
    return (
      <div className="py-16 text-center space-y-2">
        <p className="text-zinc-600 text-sm">No allocations yet.</p>
        <p className="text-xs text-zinc-700">Create allocations from Brewing → Batch Log or Intake → Batch Scheduler.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {[...byBatch.entries()].map(([batchId, allocs]) => {
        const batch = allocs[0].brew_batches;
        const totalPct = allocs.reduce((s, a) => s + Number(a.percentage), 0);
        const produced = allocs[0].produced_bbl;
        const allFulfilled = allocs.every((a) => a.fulfilled);

        return (
          <div key={batchId} className="rounded-lg border border-zinc-800 overflow-hidden">
            {/* Batch header */}
            <div className="flex items-center justify-between px-4 py-2.5 bg-zinc-900/60 border-b border-zinc-800">
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium text-zinc-100">
                  {batch ? `#${batch.batch_number} ${batch.beer_name}` : batchId}
                </span>
                {produced != null && (
                  <span className="text-xs text-zinc-500">{produced.toFixed(2)} BBL produced</span>
                )}
              </div>
              <div className="flex items-center gap-3">
                <span className={`text-xs px-2 py-0.5 rounded font-medium ${
                  Math.abs(totalPct - 100) < 0.01
                    ? "bg-emerald-900/40 text-emerald-400"
                    : totalPct > 100
                    ? "bg-red-900/40 text-red-400"
                    : "bg-amber-900/40 text-amber-400"
                }`}>
                  {totalPct.toFixed(1)}% allocated
                </span>
                {allFulfilled && allocs.length > 0 && (
                  <span className="text-xs text-emerald-400">All fulfilled</span>
                )}
              </div>
            </div>

            {/* Allocations table */}
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-left">
                  <th className="px-4 py-2 text-xs font-medium text-zinc-500">Channel</th>
                  <th className="px-4 py-2 text-xs font-medium text-zinc-500">Label</th>
                  <th className="px-4 py-2 text-xs font-medium text-zinc-500 text-right">%</th>
                  <th className="px-4 py-2 text-xs font-medium text-zinc-500 text-right">Alloc. BBL</th>
                  <th className="px-4 py-2 text-xs font-medium text-zinc-500 text-right">Exported BBL</th>
                  <th className="px-4 py-2 text-xs font-medium text-zinc-500">Status</th>
                  <th className="px-4 py-2 text-xs font-medium text-zinc-500">Lock</th>
                </tr>
              </thead>
              <tbody>
                {allocs.map((a) => (
                  <tr key={a.id} className="border-b border-zinc-800 last:border-0 hover:bg-zinc-900/20">
                    <td className="px-4 py-2.5">
                      <span className="text-xs px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">
                        {CHANNEL_LABELS[a.channel]}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-zinc-200">{a.label}</td>
                    <td className="px-4 py-2.5 text-right text-zinc-200 tabular-nums font-medium">
                      {Number(a.percentage).toFixed(1)}%
                    </td>
                    <td className="px-4 py-2.5 text-right text-zinc-400 tabular-nums">
                      {a.allocated_bbl != null ? a.allocated_bbl.toFixed(2) : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right text-zinc-400 tabular-nums">
                      {a.exported_bbl > 0 ? a.exported_bbl.toFixed(2) : "—"}
                    </td>
                    <td className="px-4 py-2.5">
                      {a.allocated_bbl == null ? (
                        <span className="text-xs text-zinc-600">Pending production</span>
                      ) : a.fulfilled ? (
                        <span className="text-xs text-emerald-400">Fulfilled</span>
                      ) : (
                        <span className="text-xs text-amber-400">
                          {a.allocated_bbl > 0
                            ? `${((a.exported_bbl / a.allocated_bbl) * 100).toFixed(0)}% fulfilled`
                            : "Unfulfilled"}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      {a.locked ? (
                        <span className="text-xs text-blue-400" title={a.lock_reason ?? undefined}>
                          Locked {a.lock_reason === "deposit_paid" ? "(deposit)" : a.lock_reason === "contract_signed" ? "(contract)" : ""}
                        </span>
                      ) : (
                        <span className="text-xs text-zinc-600">Unlocked</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

// ─── Exports Tab ─────────────────────────────────────────────────────────────

function ExportsChannelTab({ channel, exports, links, recipes, onLinksChanged }: {
  channel: ExportChannel;
  exports: ExportTransactionRow[];
  links: LinkRow[];
  recipes: Recipe[];
  onLinksChanged: () => void;
}) {
  const [showLinks, setShowLinks] = useState(false);
  const qc = useQueryClient();
  const refreshLinks = () => { qc.invalidateQueries({ queryKey: queryKeys.production.recipeSquareLinks() }); onLinksChanged(); };

  const channelExports = exports.filter(e => e.channel === channel);
  const channelMeta = CHANNEL_TABS.find(c => c.key === channel)!;

  const totalBbl  = channelExports.reduce((s, e) => s + (e.volume_bbl ?? 0), 0);
  const totalGal  = totalBbl * BBL_TO_GAL;
  const totalTax  = channelExports.reduce((s, e) => s + (e.total_excise_tax_usd ?? 0), 0);

  async function remove(id: string) {
    if (!confirm("Delete this export record?")) return;
    await fetch(`/api/production/exports/${id}`, { method: "DELETE" });
    qc.invalidateQueries({ queryKey: queryKeys.production.exports() });
  }

  return (
    <>
      <p className="text-xs text-zinc-600 mb-4">{channelMeta.description}</p>

      {channel === "taproom" && (
        <div className="mb-4 flex items-center justify-between px-3 py-2 bg-zinc-800/60 border border-zinc-700 rounded text-xs text-zinc-500">
          <span>
            {links.length > 0
              ? `${links.length} Square mapping${links.length !== 1 ? "s" : ""} configured`
              : "No Square mappings yet — link recipes to Square catalog items for inventory sync"}
          </span>
          <button
            onClick={() => setShowLinks(true)}
            className="ml-4 shrink-0 px-2.5 py-1 border border-zinc-600 hover:border-zinc-400 text-zinc-300 rounded transition-colors"
          >
            Link to Square
          </button>
        </div>
      )}

      {channelExports.length === 0 ? (
        <p className="text-sm text-zinc-600">No {channelMeta.label.toLowerCase()} exports recorded yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 bg-zinc-900/50 text-left">
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Date</th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Batch</th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Packaging</th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500 text-right">Qty</th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500 text-right">Gallons</th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500 text-right">BBL</th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500 text-right">Excise Tax</th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Status</th>
                {channel !== "taproom" && <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Recipient</th>}
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Notes</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {channelExports.map(e => (
                <tr key={e.id} className="border-b border-zinc-800 last:border-0 hover:bg-zinc-900/30">
                  <td className="px-4 py-2.5 text-zinc-400 whitespace-nowrap">{fmt(e.created_at)}</td>
                  <td className="px-4 py-2.5 text-zinc-200">
                    {e.brew_batches ? `#${e.brew_batches.batch_number} ${e.brew_batches.beer_name}` : "—"}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="px-1.5 py-0.5 rounded text-xs bg-zinc-800 text-zinc-300">{e.variant_label}</span>
                  </td>
                  <td className="px-4 py-2.5 text-right text-zinc-200">{e.quantity}</td>
                  <td className="px-4 py-2.5 text-right text-zinc-400">
                    {e.volume_bbl != null ? (e.volume_bbl * BBL_TO_GAL).toFixed(2) : "—"}
                  </td>
                  <td className="px-4 py-2.5 text-right text-zinc-400">
                    {e.volume_bbl != null ? e.volume_bbl.toFixed(4) : "—"}
                  </td>
                  <td className="px-4 py-2.5 text-right text-zinc-400">
                    ${e.total_excise_tax_usd.toFixed(2)}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`text-xs px-1.5 py-0.5 rounded ${
                      e.status === "paid" ? "bg-emerald-900/40 text-emerald-400"
                      : e.status === "unpaid" ? "bg-amber-900/40 text-amber-400"
                      : "bg-zinc-800 text-zinc-400"
                    }`}>
                      {e.status === "invoice_required" ? "Invoice Required" : e.status === "unpaid" ? "Unpaid" : "Paid"}
                    </span>
                  </td>
                  {channel !== "taproom" && <td className="px-4 py-2.5 text-zinc-400">{e.recipient_name ?? "—"}</td>}
                  <td className="px-4 py-2.5 text-zinc-500 text-xs">{e.notes ?? "—"}</td>
                  <td className="px-4 py-2.5">
                    <button onClick={() => remove(e.id)} className="text-xs text-zinc-600 hover:text-red-400">Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {channelExports.length > 0 && totalBbl > 0 && (
        <div className="mt-3 grid grid-cols-2 gap-x-8 gap-y-1 px-3 py-2.5 bg-zinc-900/60 border border-zinc-800 rounded text-xs">
          <span className="text-zinc-500">Total volume</span>
          <span className="text-zinc-300 font-medium tabular-nums">
            {totalGal.toFixed(2)} gal &nbsp;/&nbsp; {totalBbl.toFixed(4)} BBL
          </span>
          <span className="text-zinc-400 font-medium border-t border-zinc-800 pt-1 mt-0.5">Total excise tax</span>
          <span className="text-amber-300 font-semibold tabular-nums border-t border-zinc-800 pt-1 mt-0.5">${totalTax.toFixed(2)}</span>
        </div>
      )}

      {showLinks && (
        <SquareLinkManager
          recipes={recipes}
          links={links}
          onClose={() => setShowLinks(false)}
          onChanged={refreshLinks}
        />
      )}
    </>
  );
}

// ─── Root Component ───────────────────────────────────────────────────────────

export default function ExportTab() {
  const { data: exports = [] } = useQuery({
    queryKey: queryKeys.production.exports(),
    queryFn: () => fetchJson<ExportTransactionRow[]>("/api/production/exports"),
  });
  const { data: links = [] } = useQuery({
    queryKey: queryKeys.production.recipeSquareLinks(),
    queryFn: () => fetchJson<LinkRow[]>("/api/production/recipe-square-links"),
  });
  const { data: recipes = [] } = useRecipesQuery();

  const [tab, setTab] = useState<TopTab>("allocations");

  return (
    <>
      {/* Header */}
      <div className="mb-4">
        <h2 className="text-base font-medium text-zinc-100">Export</h2>
        <p className="text-sm text-zinc-500 mt-0.5">Commitments and fulfillment — track what has been allocated and what has shipped.</p>
      </div>

      {/* Top tab bar */}
      <div className="flex gap-1 mb-6 border-b border-zinc-800">
        {TOP_TABS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              tab === key
                ? "border-amber-500 text-zinc-100"
                : "border-transparent text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {label}
            {key !== "allocations" && (
              <span className="ml-1.5 text-xs text-zinc-600">
                ({exports.filter(e => e.channel === key).length})
              </span>
            )}
          </button>
        ))}
      </div>

      {tab === "allocations" && <AllocationsTab />}
      {(tab === "taproom" || tab === "distribution" || tab === "contract_brewing") && (
        <ExportsChannelTab
          key={tab}
          channel={tab}
          exports={exports}
          links={links}
          recipes={recipes}
          onLinksChanged={() => {}}
        />
      )}
    </>
  );
}
