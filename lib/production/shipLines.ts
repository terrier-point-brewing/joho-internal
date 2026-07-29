// lib/production/shipLines.ts
//
// Pure request-shaping for multi-line Export Bay shipments: several packaging
// variations of the SAME recipe shipped together against one allocation
// (e.g. 2× 1/2 keg + 3× 1/6 keg of one beer). Shared by the ship route and its
// preview so both gate on exactly the same numbers.
import type { ShipmentWarning } from "@/lib/production/allocationReserve";

export interface ShipLine {
  variation_id: string;
  quantity: number;
}

export interface ShipLinesInput {
  /** Multi-line form. */
  lines?: { variation_id: string; quantity: number | string }[];
  /** Single-line form, kept for existing callers. */
  variation_id?: string;
  quantity?: number | string;
}

/**
 * Collapse a request into one entry per variation with a summed quantity,
 * dropping blank/zero/non-numeric lines.
 *
 * Summing matters: a user can legitimately add the same variation twice (two
 * partial pallets), and availability has to be checked against the TOTAL. Two
 * lines of 6 would otherwise both clear a 10-on-hand check and then overdraw
 * cold storage by 2.
 */
export function normalizeShipLines(input: ShipLinesInput): ShipLine[] {
  const raw = input.lines?.length
    ? input.lines
    : input.variation_id
      ? [{ variation_id: input.variation_id, quantity: input.quantity ?? 0 }]
      : [];

  const totals = new Map<string, number>();
  for (const l of raw) {
    if (!l?.variation_id) continue;
    const qty = Number(l.quantity);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    totals.set(l.variation_id, (totals.get(l.variation_id) ?? 0) + qty);
  }
  return [...totals].map(([variation_id, quantity]) => ({ variation_id, quantity }));
}

/**
 * Two variations drawing on the same allocation raise the same advisory twice.
 * Collapse identical warnings so the modal doesn't repeat itself. Order of first
 * appearance is preserved so the most relevant warning stays on top.
 */
export function dedupeWarnings(warnings: ShipmentWarning[]): ShipmentWarning[] {
  const seen = new Set<string>();
  const out: ShipmentWarning[] = [];
  for (const w of warnings) {
    const key = JSON.stringify(w);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  return out;
}
