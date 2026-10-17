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
 * The "Next: …" line shown on an EMPTY tank when a future, not-yet-started
 * schedule entry exists for it. One muted line, never smaller than 11px —
 * the full detail (stage, dates, volume) lives in the Up next strip and the
 * per-equipment plans popup, so the tile only needs to say what is coming.
 */
export default function NextPlannedBox({ batchNumber, beerName, plannedStart, volumeBbl, size = "xs" }: NextPlannedBoxProps) {
  const text = `#${batchNumber ?? "?"} ${beerName} · ${fmtDate(plannedStart)}${volumeBbl != null ? ` · ${volumeBbl} BBL` : ""}`;
  return (
    <p className="text-muted truncate w-full min-w-0" style={{ fontSize: size === "sm" ? 13 : 11 }} title={text}>
      <span className="text-faint">Next:</span> {text}
    </p>
  );
}
