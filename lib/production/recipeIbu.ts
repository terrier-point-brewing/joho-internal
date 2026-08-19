/**
 * Bitterness derived from the ingredient bill.
 *
 * `recipes.ibu` is the value of record either way; `recipes.ibu_source` says
 * how it got there. Manual is the normal case and will stay that way for a
 * while — no hop in this database has an alpha acid yet — so nothing here is
 * on the critical path for recording an IBU. This is the second opinion for
 * the recipes whose bills are complete enough to offer one.
 *
 * A missing input yields null, never a partial sum. An IBU computed from three
 * of a recipe's five hop additions is not approximately right, it is wrong and
 * low, and it would be indistinguishable on screen from a real number.
 *
 * Weights come through lib/production/units.ts, which is the point of having
 * built the unit vocabulary: a hop bill in ounces converts on a known factor
 * instead of being read as a bare number.
 */

import { GALLONS_PER_BBL } from "@/lib/constants/production";
import { ouncesPerUnit } from "./units";

export interface IbuLine {
  /** Ingredient name — used only to say what is missing. */
  name: string;
  category: string | null;
  /** Quantity charged into one turn, in `unit`. */
  quantityPerTurn: number;
  unit: string;
  /** Alpha acid as a percentage, e.g. 12.5 for 12.5%. */
  alphaAcid: number | null;
  boilMinutes: number | null;
}

export interface IbuInputs {
  lines: IbuLine[];
  expectedYieldBbl: number | null;
  originalGravity: number | null;
}

export interface IbuResult {
  /** Null whenever any required input is missing. Never a partial sum. */
  value: number | null;
  /** What is missing, phrased for an operator to act on. */
  missing: string[];
}

/**
 * Tinseth:
 *   bigness          = 1.65 x 0.000125^(OG - 1)
 *   boil time factor = (1 - e^(-0.04 x minutes)) / 4.15
 *   IBU              = SUM(bigness x btf x decimal AA x oz x 7490 / gallons)
 *
 * Boil time is required per addition and deliberately not defaultable: the
 * same ounce of Citra contributes roughly ten times the bitterness at 60
 * minutes that it does in a whirlpool. Original gravity is required for the
 * same reason in the other direction — bigness falls as wort thickens, so
 * assuming a standard gravity would overstate an imperial stout's bitterness.
 */
export function computeIbu(inputs: IbuInputs): IbuResult {
  const missing: string[] = [];

  const gallons =
    inputs.expectedYieldBbl != null && inputs.expectedYieldBbl > 0
      ? inputs.expectedYieldBbl * GALLONS_PER_BBL
      : null;
  if (gallons == null) missing.push("expected yield");
  if (inputs.originalGravity == null) missing.push("original gravity");

  const hops = inputs.lines.filter((l) => l.category === "Hops");
  if (hops.length === 0) missing.push("no hops in the bill");

  const additions: { oz: number; alpha: number; minutes: number }[] = [];
  for (const line of hops) {
    const oz = ouncesPerUnit(line.unit) == null
      ? null
      : line.quantityPerTurn * ouncesPerUnit(line.unit)!;

    if (line.alphaAcid == null) missing.push(`alpha acid for ${line.name}`);
    if (line.boilMinutes == null) missing.push(`boil time for ${line.name}`);
    if (oz == null) missing.push(`a weighable unit for ${line.name} (has "${line.unit}")`);

    if (line.alphaAcid == null || line.boilMinutes == null || oz == null) continue;
    additions.push({ oz, alpha: line.alphaAcid / 100, minutes: line.boilMinutes });
  }

  if (missing.length > 0 || gallons == null || inputs.originalGravity == null) {
    return { value: null, missing };
  }

  const bigness = 1.65 * Math.pow(0.000125, inputs.originalGravity - 1);
  const total = additions.reduce((sum, a) => {
    const boilTimeFactor = (1 - Math.exp(-0.04 * a.minutes)) / 4.15;
    return sum + (bigness * boilTimeFactor * a.alpha * a.oz * 7490) / gallons;
  }, 0);

  return { value: total, missing: [] };
}

/** True when the bill carries everything a calculated IBU needs. */
export function canCalculateIbu(inputs: IbuInputs): boolean {
  return computeIbu(inputs).value != null;
}
