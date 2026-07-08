"use client";

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

  const coldIds   = new Set(tanks.filter((t) => t.type === "cold_storage").map((t) => t.id));
  const batchById = Object.fromEntries(batches.map((b) => [b.id, b]));

  // Accumulate net qty per (beerName, packagingName) pair
  const tally = new Map<string, number>(); // key = `${beerName}||${packagingName}`

  for (const tr of transfers) {
    if (!tr.to_tank_id || !coldIds.has(tr.to_tank_id)) continue;
    if (tr.transfer_type !== "kegging" && tr.transfer_type !== "canning") continue;

    const beerName = batchById[tr.batch_id]?.beer_name ?? "Unknown";
    const net = Math.round(tr.quantity ?? 0);
    if (net > 0) {
      const packagingName = tr.packaging_variations?.name ?? (tr.transfer_type === "kegging" ? "Kegs" : "Cans");
      const key = `${beerName}||${packagingName}`;
      tally.set(key, (tally.get(key) ?? 0) + net);
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
    return <p className="text-faint text-sm">No kegged or canned product in cold storage yet.</p>;
  }

  // Group consecutive rows by beerName for display
  return (
    <div className="max-w-lg">
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line bg-surface/50 text-left">
              <th className="px-4 py-2.5 text-xs font-medium text-muted">Beer</th>
              <th className="px-4 py-2.5 text-xs font-medium text-muted">Packaging</th>
              <th className="px-4 py-2.5 text-xs font-medium text-muted text-right">Qty</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const showBeer = i === 0 || rows[i - 1].beerName !== row.beerName;
              const isFirstInGroup = showBeer && i > 0;
              return (
                <tr
                  key={`${row.beerName}||${row.packagingName}`}
                  className={`border-b border-line/50 last:border-0 ${isFirstInGroup ? "border-t border-line-strong" : ""}`}
                >
                  <td className="px-4 py-2.5 font-medium text-primary">
                    {showBeer ? row.beerName : ""}
                  </td>
                  <td className="px-4 py-2.5 text-secondary">{row.packagingName}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-strong font-medium">
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
