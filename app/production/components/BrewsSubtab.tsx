"use client";

import { useEffect, useState } from "react";
import { useTransfersQuery, useEquipmentQuery, useBatchesQuery } from "../hooks/queries";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface KegTypeTally {
  name: string;
  quantity: number;   // net (after adjustments)
}

interface BeerRow {
  beerName: string;
  kegs: KegTypeTally[];   // per-keg-type net totals
  totalKegs: number;      // sum of kegs
  totalCans: number;      // net cans
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt(n: number) {
  return n.toLocaleString("en-US");
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function BrewsSubtab() {
  const { data: transfers = [] } = useTransfersQuery();
  const { data: tanks = [] }     = useEquipmentQuery();
  const { data: batches = [] }   = useBatchesQuery();

  // All adjustments fetched once — keyed by batch_transfer_id → net delta
  const [adjByTransfer, setAdjByTransfer] = useState<Record<string, number>>({});

  useEffect(() => {
    fetch("/api/production/brew-adjustments")
      .then((r) => r.ok ? r.json() : [])
      .then((rows: { batch_transfer_id: string; quantity: number }[]) => {
        const map: Record<string, number> = {};
        for (const r of rows) {
          map[r.batch_transfer_id] = (map[r.batch_transfer_id] ?? 0) + Number(r.quantity);
        }
        setAdjByTransfer(map);
      })
      .catch(() => {});
  }, []);

  const coldStorageTankIds = new Set(tanks.filter((t) => t.type === "cold_storage").map((t) => t.id));
  const batchById = Object.fromEntries(batches.map((b) => [b.id, b]));

  const coldTransfers = transfers.filter(
    (t) => t.to_tank_id && coldStorageTankIds.has(t.to_tank_id) &&
           (t.transfer_type === "kegging" || t.transfer_type === "canning")
  );

  // Aggregate by beer name
  const byBeer = new Map<string, {
    kegs: Map<string, number>;   // keg type name → net qty
    cans: number;
  }>();

  for (const tr of coldTransfers) {
    const beerName = batchById[tr.batch_id]?.beer_name ?? "Unknown";
    if (!byBeer.has(beerName)) byBeer.set(beerName, { kegs: new Map(), cans: 0 });
    const row = byBeer.get(beerName)!;
    const adjDelta = adjByTransfer[tr.id] ?? 0;

    if (tr.transfer_type === "kegging") {
      const kd = tr.kegging_detail;
      if (kd?.kegs && kd.kegs.length > 0) {
        // Distribute adjustment proportionally across keg types, or just apply to total
        const initialTotal = kd.kegs.reduce((s, k) => s + k.quantity, 0);
        for (const k of kd.kegs) {
          if (k.quantity === 0) continue;
          // Pro-rate the adjustment across keg types by their initial share
          const share = initialTotal > 0 ? k.quantity / initialTotal : 0;
          const net   = Math.round(k.quantity + adjDelta * share);
          row.kegs.set(k.name, (row.kegs.get(k.name) ?? 0) + net);
        }
      } else {
        // Fallback: total_kegs only
        const initialTotal = kd?.total_kegs ?? 0;
        const net = initialTotal + adjDelta;
        row.kegs.set("Kegs", (row.kegs.get("Kegs") ?? 0) + net);
      }
    } else {
      // canning
      const initialTotal = tr.canning_detail?.total_cans ?? 0;
      row.cans += initialTotal + adjDelta;
    }
  }

  const rows: BeerRow[] = [...byBeer.entries()]
    .map(([beerName, data]) => {
      const kegs = [...data.kegs.entries()]
        .map(([name, quantity]) => ({ name, quantity }))
        .filter((k) => k.quantity > 0)
        .sort((a, b) => b.quantity - a.quantity);
      const totalKegs = kegs.reduce((s, k) => s + k.quantity, 0);
      const totalCans = Math.max(0, Math.round(data.cans));
      return { beerName, kegs, totalKegs, totalCans };
    })
    .filter((r) => r.totalKegs > 0 || r.totalCans > 0)
    .sort((a, b) => a.beerName.localeCompare(b.beerName));

  if (rows.length === 0) {
    return <p className="text-zinc-600 text-sm">No kegged or canned product in cold storage yet.</p>;
  }

  return (
    <div className="space-y-3 max-w-2xl">
      <div className="overflow-x-auto rounded-lg border border-zinc-800">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 bg-zinc-900/50 text-left">
              <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Beer</th>
              <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Kegs</th>
              <th className="px-4 py-2.5 text-xs font-medium text-zinc-500 text-right">Total Kegs</th>
              <th className="px-4 py-2.5 text-xs font-medium text-zinc-500 text-right">Cans</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={row.beerName} className={`border-b border-zinc-800/50 last:border-0 ${i % 2 !== 0 ? "bg-zinc-900/20" : ""}`}>
                <td className="px-4 py-3 font-medium text-zinc-100 align-top">{row.beerName}</td>
                <td className="px-4 py-3 align-top">
                  {row.kegs.length > 0 ? (
                    <div className="space-y-0.5">
                      {row.kegs.map((k) => (
                        <div key={k.name} className="flex items-center gap-2">
                          <span className="text-amber-400 font-mono font-medium text-xs tabular-nums">{fmt(k.quantity)}×</span>
                          <span className="text-zinc-400 text-xs">{k.name}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <span className="text-zinc-700 text-xs">—</span>
                  )}
                </td>
                <td className="px-4 py-3 text-right align-top tabular-nums">
                  {row.totalKegs > 0
                    ? <span className="text-zinc-200 font-medium">{fmt(row.totalKegs)}</span>
                    : <span className="text-zinc-700">—</span>}
                </td>
                <td className="px-4 py-3 text-right align-top tabular-nums">
                  {row.totalCans > 0
                    ? <span className="text-zinc-200 font-medium">{fmt(row.totalCans)}</span>
                    : <span className="text-zinc-700">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
          {rows.length > 1 && (
            <tfoot>
              <tr className="border-t border-zinc-700 bg-zinc-900/40">
                <td className="px-4 py-2.5 text-xs font-medium text-zinc-400">Total</td>
                <td />
                <td className="px-4 py-2.5 text-right font-medium text-zinc-200 tabular-nums">
                  {fmt(rows.reduce((s, r) => s + r.totalKegs, 0))}
                </td>
                <td className="px-4 py-2.5 text-right font-medium text-zinc-200 tabular-nums">
                  {fmt(rows.reduce((s, r) => s + r.totalCans, 0)) || "—"}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
