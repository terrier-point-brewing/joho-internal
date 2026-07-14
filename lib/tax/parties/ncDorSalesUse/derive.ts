/**
 * NC DOR Sales & Use — the SINGLE, pure figure derivation shared by every
 * caller so the displayed worksheet can never drift from what the server saves.
 *
 * Given a worksheet field set (computed receipts + manual `lineN_purchases` +
 * manual adjustment lines) it re-derives, in one place:
 *   - each rate line's `lineN_tax = round((purchases + receipts) × rate)`
 *   - the page-2 county rows (`county_${code}_{2pct|225pct|transit}`), splitting
 *     each county line's purchases across that line's counties by the SAME
 *     receipts weights, so the rows still reconcile to the page-1 line taxes
 *   - the dependent totals (lines 13/15/21)
 *
 * Used identically by:
 *   - `./calc.ts`  → `computeNcDorFigures` (initial Square compute, purchases 0)
 *   - `./template.ts` → `mergeWorksheet` (server recompute + manual-edit merge)
 *   - `../../ncDorWorksheetMath.ts` → `recomputeClientTotals` (client live edit)
 *
 * Every rate VALUE (state/line/local/transit) is read from the `rateMap`
 * parameter (built via `buildRateMap(await listTaxRates(sb))`, see
 * `@/lib/tax/rates`) — this module holds no rate constants of its own, only
 * the pure key builders it imports. Deliberately zero server imports —
 * `@/lib/tax/rates` is side-effect-free (only a TYPE import of
 * `SupabaseClient`) and `./rates` is structural-only, so this stays a
 * client-importable pure module. The per-county receipts the split needs are
 * read from computed `county_${code}_receipts` fields stamped at compute
 * time, so the client derivation is self-contained from the worksheet fields
 * + rateMap alone (no schedule or Square fetch). All money is integer cents;
 * every per-line/per-county tax is rounded with `Math.round` exactly once.
 */
import type { WorksheetFields } from "@/lib/tax/types";
import { ncSalesLineKey, ncLocalKey, ncTransitKey } from "@/lib/tax/rates";
import {
  RATE_LINES,
  NC_COUNTIES,
  countyRateLine,
  transitRateLine,
  type CountyTier,
  type RateLineKey,
} from "./rates";

const round = (v: number) => Math.round(v);
const num = (v: number | string | null | undefined) => Number(v ?? 0);

/** Rate lines whose tax is built up from the per-county page-2 schedule. */
const COUNTY_LINE_KEYS = new Set<RateLineKey>(["9", "10", "11", "12"]);

/** Structural county-code allowlist — guards `readCountyReceipts` against a
 * stray field matching the `county_*_receipts` pattern for a non-county key. */
const KNOWN_COUNTY_CODES = new Set(NC_COUNTIES.map((c) => c.code));

/** A county's resolved local/transit tier, read from the rate map. */
function countyTierFromRateMap(code: string, rateMap: Record<string, number>): CountyTier {
  return { local: rateMap[ncLocalKey(code)] ?? 0, transit: rateMap[ncTransitKey(code)] ?? 0 };
}

/**
 * Largest-remainder (Hamilton) split of `total` cents across `weights`, so the
 * allocations sum EXACTLY to `total` with no lost or duplicated cent. When all
 * weights are ≤ 0 (e.g. a purchases entry on a line with zero receipts) the
 * amount is spread as evenly as possible rather than dropped.
 */
export function allocateByWeights(total: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  if (totalWeight <= 0) {
    const base = Math.floor(total / weights.length);
    const alloc = weights.map(() => base);
    let remainder = total - base * weights.length;
    for (let i = 0; remainder > 0 && i < alloc.length; i++, remainder--) alloc[i] += 1;
    return alloc;
  }
  const raw = weights.map((w) => (total * w) / totalWeight);
  const floors = raw.map((v) => Math.floor(v));
  let remainder = total - floors.reduce((s, v) => s + v, 0);
  const alloc = floors.slice();
  const order = raw
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; remainder > 0 && order.length > 0; k++, remainder--) {
    alloc[order[k % order.length].i] += 1;
  }
  return alloc;
}

/**
 * Recompute the dependent totals (lines 13/15/21) from a field set. The single
 * definition of these totals, shared everywhere `lineN_tax` has already been
 * derived.
 *
 * L13 = Σ tax on rate lines 4–12
 * L15 = L13 + L14 (excess collections)
 * L21 = L15 + penalty + interest − less_prepay + prepay_next − credit
 */
export function computeDependentTotals(
  fields: WorksheetFields,
): { line13_total: number; line15_total: number; line21_total_due: number } {
  const line13_total = RATE_LINES.reduce((s, n) => s + num(fields[`line${n}_tax`]), 0);
  const line15_total = line13_total + num(fields.line14_excess);
  const line21_total_due =
    line15_total +
    num(fields.line16_penalty) +
    num(fields.line17_interest) -
    num(fields.line18_less_prepay) +
    num(fields.line19_prepay_next) -
    num(fields.line20_credit);
  return { line13_total, line15_total, line21_total_due };
}

interface CountyReceipt {
  code: string;
  receipts: number;
  tier: CountyTier;
}

/**
 * Read the per-county receipts stamped as computed `county_${code}_receipts`
 * fields by the initial compute. The tier is read from the rateMap by code,
 * so the client needs no schedule access to split purchases.
 */
function readCountyReceipts(fields: WorksheetFields, rateMap: Record<string, number>): CountyReceipt[] {
  const out: CountyReceipt[] = [];
  for (const key of Object.keys(fields)) {
    const m = /^county_(.+)_receipts$/.exec(key);
    if (!m) continue;
    const code = m[1];
    if (!KNOWN_COUNTY_CODES.has(code)) continue;
    out.push({ code, receipts: num(fields[key]), tier: countyTierFromRateMap(code, rateMap) });
  }
  return out;
}

/**
 * Rebuild one county rate line (9/10 local, 11/12 transit): split that line's
 * manual purchases across its member counties by receipts weight, set each
 * county's page-2 row, and return the page-1 line tax as the SUM of the rounded
 * county rows (so `Σ county rows = lineN_tax` holds by construction).
 */
function deriveCountyLine(
  fields: WorksheetFields,
  counties: CountyReceipt[],
  kind: "local" | "transit",
  lineKey: RateLineKey,
  rateMap: Record<string, number>,
): void {
  const members = counties.filter((c) =>
    kind === "local" ? countyRateLine(c.tier.local) === lineKey : transitRateLine(c.tier.transit) === lineKey,
  );
  fields[`line${lineKey}_tax`] = 0;
  if (members.length === 0) return;

  const rate = rateMap[ncSalesLineKey(Number(lineKey))] ?? 0;
  const purchases = num(fields[`line${lineKey}_purchases`]);
  const alloc = allocateByWeights(
    purchases,
    members.map((m) => m.receipts),
  );

  let lineTax = 0;
  members.forEach((m, i) => {
    const tax = round((m.receipts + alloc[i]) * rate);
    lineTax += tax;
    if (kind === "local") {
      const rowKey = m.tier.local === 0.0225 ? `county_${m.code}_225pct` : `county_${m.code}_2pct`;
      fields[rowKey] = tax;
    } else {
      fields[`county_${m.code}_transit`] = tax;
    }
  });
  fields[`line${lineKey}_tax`] = lineTax;
}

/**
 * The shared derivation. Returns a NEW field set with every `lineN_tax`, the
 * page-2 `county_*` rows, and lines 13/15/21 re-derived from the (computed)
 * receipts + (manual) purchases + adjustment lines. All other keys pass through
 * unchanged. Runs identically server-side and client-side.
 */
export function deriveNcDorFigures(
  fields: WorksheetFields,
  rateMap: Record<string, number>,
): WorksheetFields {
  const f: WorksheetFields = { ...fields };
  const counties = readCountyReceipts(f, rateMap);

  // Non-county rate lines (4–8): tax = round((purchases + receipts) × rate).
  for (const n of RATE_LINES) {
    const key = String(n) as RateLineKey;
    if (COUNTY_LINE_KEYS.has(key)) continue; // rebuilt from the county split below
    const receipts = num(f[`line${key}_receipts`]);
    const purchases = num(f[`line${key}_purchases`]);
    const rate = rateMap[ncSalesLineKey(n)] ?? 0;
    f[`line${key}_tax`] = round((receipts + purchases) * rate);
  }

  // County rate lines (9–12): built from the per-county page-2 schedule.
  deriveCountyLine(f, counties, "local", "9", rateMap);
  deriveCountyLine(f, counties, "local", "10", rateMap);
  deriveCountyLine(f, counties, "transit", "11", rateMap);
  deriveCountyLine(f, counties, "transit", "12", rateMap);

  const totals = computeDependentTotals(f);
  f.line13_total = totals.line13_total;
  f.line15_total = totals.line15_total;
  f.line21_total_due = totals.line21_total_due;
  return f;
}
