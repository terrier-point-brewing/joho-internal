/**
 * Process-CMYK for a brand color, derived from its hex.
 *
 * The canon stores `cmyk` as a string alongside `hex` so print collateral can
 * quote a press value without re-deriving it. This is the one place that
 * derivation lives.
 *
 * WHY DERIVED RATHER THAN AUTHORED: the four Tier-1 colors carried hand-entered
 * CMYK before this module existed, and all four reproduce here exactly —
 * indigo "59 43 0 64", paper "0 2 6 4", seal-red "0 85 74 32", camphor
 * "0 8 26 30". They were the naive conversion all along, so deriving the rest
 * the same way is consistent with them rather than a second provenance.
 *
 * WHAT THIS IS NOT: a color-managed separation. There is no ICC profile here,
 * so these are *process* values, not press-proofed ones under a named condition
 * (SWOP, FOGRA…). A printer running a critical job should proof and override.
 * Brand-critical spot matching was removed from the canon entirely rather than
 * carry Pantone numbers nobody maintains (migration 20260907100000).
 */

/** Space-separated C M Y K percentages, no unit — "59 43 0 64". */
export function cmykFromHex(hex: string): string | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;

  const int = parseInt(match[1], 16);
  const r = ((int >> 16) & 0xff) / 255;
  const g = ((int >> 8) & 0xff) / 255;
  const b = (int & 0xff) / 255;

  const k = 1 - Math.max(r, g, b);
  // Pure black: the max channel is 0, so the c/m/y denominator would be 0.
  // K carries the whole ink load.
  if (k === 1) return "0 0 0 100";

  const pct = (v: number) => Math.round(((1 - v - k) / (1 - k)) * 100);
  return `${pct(r)} ${pct(g)} ${pct(b)} ${Math.round(k * 100)}`;
}
