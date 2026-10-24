/**
 * The arithmetic of giving beer a home, with no server imports so the Export
 * Bay can preview exactly what the server will do. rehome.ts re-exports it.
 */

const EPS = 1e-4;

/** bbl ⇄ percentage of a batch. */
export function bblToPct(bbl: number, basisBbl: number): number {
  if (basisBbl <= EPS) return 0;
  return Math.round((bbl / basisBbl) * 100 * 100) / 100;
}

/**
 * The slice of a paid deposit that leaves with `deltaPct` of a source's
 * share. Same formula as issueDepositReduction (paid × (1 − new/current)),
 * rounded the same way, so what the picker previews is what Square charges.
 */
export function depositRefundCents(
  source: { percentage: number; deposit?: { paidCents: number } | null },
  deltaPct: number,
): number {
  const paid = source.deposit?.paidCents ?? 0;
  if (paid <= 0 || source.percentage <= 0) return 0;
  const newPct = Math.round((source.percentage - deltaPct) * 100) / 100;
  return Math.round(paid * (1 - newPct / source.percentage));
}

/** What drawing `bbl` of a `basisBbl` batch off this source refunds its partner. */
export function refundCentsForDraw(
  source: { requires: string; percentage: number; deposit?: { paidCents: number; refundable: boolean } | null },
  bbl: number,
  basisBbl: number,
): number {
  if (source.requires !== "refund") return 0;
  return depositRefundCents(source, bblToPct(bbl, basisBbl));
}
