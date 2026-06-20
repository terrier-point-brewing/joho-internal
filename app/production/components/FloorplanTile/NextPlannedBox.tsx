"use client";

import { fmtDate } from "@/lib/utils/formatting";

interface NextPlannedBoxProps {
  batchNumber: string | null;
  beerName: string;
  plannedStart: string;
  volumeBbl: number | null;
  /** "sm" = mobile card text size, "xs" (default) = dense grid-tile text size */
  size?: "sm" | "xs";
}

/**
 * Renders the "Next planned" callout shown on a tank tile when a future,
 * not-yet-started schedule entry exists for it — used identically across
 * the grid tile (occupied-but-has-a-next-occupant case), the grid tile
 * (fully empty case), and the mobile card empty-tank case, so all three
 * read with the same label/format/sizing.
 */
export default function NextPlannedBox({ batchNumber, beerName, plannedStart, volumeBbl, size = "xs" }: NextPlannedBoxProps) {
  const labelSize = size === "sm" ? 11 : 7;
  const titleSize = size === "sm" ? 13 : 8;
  const metaSize  = size === "sm" ? 12 : 7;
  return (
    <div className="px-1 py-0.5 rounded bg-zinc-800/60 border border-zinc-700/50 w-full min-w-0">
      <p className="text-zinc-500 font-semibold uppercase tracking-wide" style={{ fontSize: labelSize }}>Next planned</p>
      <p className="text-zinc-300 font-medium truncate" style={{ fontSize: titleSize }} title={`#${batchNumber ?? "?"} ${beerName}`}>
        #{batchNumber ?? "?"} {beerName}
      </p>
      <p className="text-zinc-600 truncate" style={{ fontSize: metaSize }}>
        {fmtDate(plannedStart)}{volumeBbl != null && ` · ${volumeBbl} BBL`}
      </p>
    </div>
  );
}
