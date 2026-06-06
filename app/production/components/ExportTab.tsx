"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRecipesQuery, fetchJson } from "../hooks/queries";
import { SquareLinkManager, LinkRow } from "./SquareLinkManager";

const EXPORTS_KEY = ["production", "exports"] as const;

// ─── Types ───────────────────────────────────────────────────────────────────

export type ExportChannel = "taproom" | "distribution" | "contract_brewing";

interface BatchExport {
  id: string;
  batch_id: string;
  channel: ExportChannel;
  recipient_id: string | null;
  recipient_name: string | null;
  product_type: "keg" | "can" | "growler" | "other";
  quantity: number;
  /** Packaging format label, e.g. "1/6 BBL" for kegs or "can" for cans. */
  unit: string;
  volume_bbl: number | null;
  notes: string | null;
  /** Federal excise tax (USD) persisted at export time. */
  federal_excise_tax_usd: number | null;
  /** State (NC) excise tax (USD) persisted at export time. */
  state_excise_tax_usd: number | null;
  // Square API fields — populated when synced (taproom channel only)
  square_catalog_item_id: string | null;
  square_location_id: string | null;
  square_synced_at: string | null;
  created_at: string;
  brew_batches: { id: string; beer_name: string; batch_number: number } | null;
}

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

// Federal craft brewer excise tax rate (< 2M BBL/year, first 60k BBL) — used as
// fallback if the stored value is null (i.e., pre-migration export records).
const FEDERAL_EXCISE_RATE_PER_BBL = 3.50;
// NC excise tax rate (beer) per gallon
const NC_EXCISE_RATE_PER_GAL = 0.62;
const BBL_TO_GAL = 31;

function fmt(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function ExportTab() {
  const qc = useQueryClient();
  const { data: exports = [] } = useQuery({
    queryKey: EXPORTS_KEY,
    queryFn: () => fetchJson<BatchExport[]>("/api/production/exports"),
  });
  const { data: links = [] } = useQuery({
    queryKey: ["production", "recipe-square-links"],
    queryFn: () => fetchJson<LinkRow[]>("/api/production/recipe-square-links"),
  });
  const { data: recipes = [] } = useRecipesQuery();
  const refresh = () => qc.invalidateQueries({ queryKey: EXPORTS_KEY });
  const refreshLinks = () => qc.invalidateQueries({ queryKey: ["production", "recipe-square-links"] });

  const [channel, setChannel] = useState<ExportChannel>("taproom");
  const [showLinks, setShowLinks] = useState(false);

  const channelExports = exports.filter(e => e.channel === channel);
  const channelMeta = CHANNEL_TABS.find(c => c.key === channel)!;

  const totalBbl     = channelExports.reduce((s, e) => s + (e.volume_bbl ?? 0), 0);
  const totalGal     = totalBbl * BBL_TO_GAL;
  // Use stored excise values when present; fall back to computed for pre-migration records.
  const totalFederal = channelExports.reduce((s, e) =>
    s + (e.federal_excise_tax_usd ?? (e.volume_bbl ?? 0) * FEDERAL_EXCISE_RATE_PER_BBL), 0);
  const totalNC = channelExports.reduce((s, e) =>
    s + (e.state_excise_tax_usd ?? (e.volume_bbl ?? 0) * BBL_TO_GAL * NC_EXCISE_RATE_PER_GAL), 0);

  async function remove(id: string) {
    if (!confirm("Delete this export record?")) return;
    await fetch(`/api/production/exports/${id}`, { method: "DELETE" });
    await refresh();
  }

  return (
    <>
      {/* Header */}
      <div className="mb-4">
        <h2 className="text-base font-medium text-zinc-100">Export</h2>
        <p className="text-sm text-zinc-500 mt-0.5">Finished product leaving the brewery — exported via the Floorplan cold storage tiles</p>
      </div>

      {/* Channel subtab bar */}
      <div className="flex gap-1 mb-6 border-b border-zinc-800">
        {CHANNEL_TABS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setChannel(key)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              channel === key
                ? "border-amber-500 text-zinc-100"
                : "border-transparent text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {label}
            <span className="ml-1.5 text-xs text-zinc-600">
              ({exports.filter(e => e.channel === key).length})
            </span>
          </button>
        ))}
      </div>

      {/* Channel description */}
      <p className="text-xs text-zinc-600 mb-4">{channelMeta.description}</p>

      {/* Square link manager button for taproom */}
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

      {/* Exports table */}
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
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500 text-right">Fed. Excise</th>
                <th className="px-4 py-2.5 text-xs font-medium text-zinc-500 text-right">NC Excise</th>
                {channel !== "taproom" && <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Recipient</th>}
                {channel === "taproom" && <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Square Sync</th>}
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
                    <span className="px-1.5 py-0.5 rounded text-xs bg-zinc-800 text-zinc-300">{e.unit}</span>
                  </td>
                  <td className="px-4 py-2.5 text-right text-zinc-200">{e.quantity}</td>
                  <td className="px-4 py-2.5 text-right text-zinc-400">
                    {e.volume_bbl != null ? (e.volume_bbl * BBL_TO_GAL).toFixed(2) : "—"}
                  </td>
                  <td className="px-4 py-2.5 text-right text-zinc-400">
                    {e.volume_bbl != null ? e.volume_bbl.toFixed(4) : "—"}
                  </td>
                  <td className="px-4 py-2.5 text-right text-zinc-400">
                    {e.federal_excise_tax_usd != null
                      ? `$${e.federal_excise_tax_usd.toFixed(2)}`
                      : e.volume_bbl != null ? `$${(e.volume_bbl * FEDERAL_EXCISE_RATE_PER_BBL).toFixed(2)}` : "—"}
                  </td>
                  <td className="px-4 py-2.5 text-right text-zinc-400">
                    {e.state_excise_tax_usd != null
                      ? `$${e.state_excise_tax_usd.toFixed(2)}`
                      : e.volume_bbl != null ? `$${(e.volume_bbl * BBL_TO_GAL * NC_EXCISE_RATE_PER_GAL).toFixed(2)}` : "—"}
                  </td>
                  {channel !== "taproom" && <td className="px-4 py-2.5 text-zinc-400">{e.recipient_name ?? "—"}</td>}
                  {channel === "taproom" && (
                    <td className="px-4 py-2.5">
                      {e.square_synced_at
                        ? <span className="text-xs text-emerald-400">Synced {fmt(e.square_synced_at)}</span>
                        : <span className="text-xs text-zinc-600">Not synced</span>}
                    </td>
                  )}
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

      {/* Excise tax summary */}
      {channelExports.length > 0 && totalBbl > 0 && (
        <div className="mt-3 grid grid-cols-2 gap-x-8 gap-y-1 px-3 py-2.5 bg-zinc-900/60 border border-zinc-800 rounded text-xs">
          <span className="text-zinc-500">Total volume</span>
          <span className="text-zinc-300 font-medium tabular-nums">
            {totalGal.toFixed(2)} gal &nbsp;/&nbsp; {totalBbl.toFixed(4)} BBL
          </span>
          <span className="text-zinc-500">Federal excise ($3.50/BBL)</span>
          <span className="text-amber-400 font-medium tabular-nums">${totalFederal.toFixed(2)}</span>
          <span className="text-zinc-500">NC excise ($0.62/gal)</span>
          <span className="text-amber-400 font-medium tabular-nums">${totalNC.toFixed(2)}</span>
          <span className="text-zinc-400 font-medium border-t border-zinc-800 pt-1 mt-0.5">Total excise</span>
          <span className="text-amber-300 font-semibold tabular-nums border-t border-zinc-800 pt-1 mt-0.5">${(totalFederal + totalNC).toFixed(2)}</span>
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
