"use client";

import { useEffect, useState } from "react";
import { useTransfersQuery, useEquipmentQuery, useBatchesQuery } from "../hooks/queries";

interface StockRow {
  beerName: string;
  packagingName: string;
  qty: number;
}

export default function BrewsSubtab() {
  const { data: transfers = [] } = useTransfersQuery();
  const { data: tanks = [] }     = useEquipmentQuery();
  const { data: batches = [] }   = useBatchesQuery();

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

  const coldIds   = new Set(tanks.filter((t) => t.type === "cold_storage").map((t) => t.id));
  const batchById = Object.fromEntries(batches.map((b) => [b.id, b]));

  // Accumulate net qty per (beerName, packagingName) pair
  const tally = new Map<string, number>(); // key = `${beerName}||${packagingName}`

  for (const tr of transfers) {
    if (!tr.to_tank_id || !coldIds.has(tr.to_tank_id)) continue;
    if (tr.transfer_type !== "kegging" && tr.transfer_type !== "canning") continue;

    const beerName = batchById[tr.batch_id]?.beer_name ?? "Unknown";
    const adj      = adjByTransfer[tr.id] ?? 0;

    if (tr.transfer_type === "kegging") {
      const kd = tr.kegging_detail;
      const net = Math.round((kd?.quantity ?? 0) + adj);
      if (net > 0) {
        const key = `${beerName}||${kd?.name || "Kegs"}`;
        tally.set(key, (tally.get(key) ?? 0) + net);
      }
    } else {
      const cd = tr.canning_detail;
      const cansPerUnit = cd ? (cd.format === "case" ? cd.cans_per_case : cd.format === "pack" ? cd.cans_per_pack : 1) : 0;
      const net = (cd ? cd.quantity * cansPerUnit : 0) + adj;
      if (net > 0) {
        const key = `${beerName}||Cans`;
        tally.set(key, (tally.get(key) ?? 0) + net);
      }
    }
  }

  // Flatten to rows, sorted by beer then packaging name
  const rows: StockRow[] = [...tally.entries()]
    .map(([key, qty]) => {
      const [beerName, packagingName] = key.split("||");
      return { beerName, packagingName, qty };
    })
    .sort((a, b) =>
      a.beerName.localeCompare(b.beerName) || a.packagingName.localeCompare(b.packagingName)
    );

  if (rows.length === 0) {
    return <p className="text-zinc-600 text-sm">No kegged or canned product in cold storage yet.</p>;
  }

  // Group consecutive rows by beerName for display
  return (
    <div className="max-w-lg">
      <div className="overflow-x-auto rounded-lg border border-zinc-800">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 bg-zinc-900/50 text-left">
              <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Beer</th>
              <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Packaging</th>
              <th className="px-4 py-2.5 text-xs font-medium text-zinc-500 text-right">Qty</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const showBeer = i === 0 || rows[i - 1].beerName !== row.beerName;
              const isFirstInGroup = showBeer && i > 0;
              return (
                <tr
                  key={`${row.beerName}||${row.packagingName}`}
                  className={`border-b border-zinc-800/50 last:border-0 ${isFirstInGroup ? "border-t border-zinc-700" : ""}`}
                >
                  <td className="px-4 py-2.5 font-medium text-zinc-100">
                    {showBeer ? row.beerName : ""}
                  </td>
                  <td className="px-4 py-2.5 text-zinc-400">{row.packagingName}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-zinc-200 font-medium">
                    {row.qty.toLocaleString("en-US")}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
