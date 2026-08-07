// lib/production/coldStorageTransform.ts
//
// Pure preview math for a cold-storage transform — reshaping N units of one
// packaging variation into M units of another within the same batch. The
// operation runs in BOTH directions and the maths is the same either way:
//
//   break down   1 x 1/2 Keg  ->  3 x 1/6 Keg   (M > N, smaller units)
//   build up     3 x 1/6 Keg  ->  1 x 1/2 Keg   (M < N, larger units)
//
// The build-up is not an exotic case: it is how an operator gets stock into the
// shape a phantom-export reconcile demands, because reconcilePhantom only
// accepts a lot of the exact size that was booked and never recomputes excise.
// Wrong shape -> transform into the right shape -> reconcile.
//
// This MIRRORS the database's cold_storage_transforms_never_creates_volume
// constraint; it does not replace it. The DB is the enforcer, always. The point
// of computing it here is that an operator should see "that's more beer than you
// started with" while they're still typing, rather than getting a rejected
// request after they commit. The two must agree EXACTLY — see the
// createsVolume/maxToUnits notes below for the algebra they share.
//
// Shrinkage is expected and fine in either direction: you lose beer breaking a
// half keg into sixtels, and you lose beer combining sixtels into a half keg.
// That loss is real and gets recorded rather than rounded away.
//
// What is NOT loss is rounding. A 1/6 bbl is 661.33 fl oz and we store 661, so
// three stored sixtels come to 1983 against a stored half keg's 1984 — a one
// ounce gap that exists only in our own numbers. VOLUME_ROUNDING_SLACK_PER_UNIT
// is the allowance for exactly that, and nothing more.

import { BBL_TO_FL_OZ, VOLUME_ROUNDING_SLACK_PER_UNIT_FL_OZ as SLACK_PER_UNIT } from "@/lib/constants/production";

/** Volume comparisons tolerate this much float dust before calling it a gain. */
const EPS = 1e-6;

/**
 * Rounding allowance for a transform of these counts, in fl oz.
 *
 * Proportional to units, not flat, because each stored volume carries its own
 * rounding error and n units carry it n times: 3 x 1/6 -> 1 x 1/2 is short by 1
 * fl oz, 30 x 1/6 -> 10 x 1/2 by 10. A flat tolerance would pass the small case
 * and fail the identical large one — the same physical operation, ten times
 * over. Both sides count, since either side can be the rounded one.
 *
 * MIRRORED IN SQL as `(from_units + to_units) * 0.5` in the
 * cold_storage_transforms_never_creates_volume constraint. Change both together.
 */
export function roundingSlackFlOz(fromUnits: number, toUnits: number): number {
  return (fromUnits + toUnits) * SLACK_PER_UNIT;
}

export interface TransformInput {
  fromUnits: number;
  fromVolumeFlOz: number;
  toUnits: number;
  toVolumeFlOz: number;
}

export interface TransformPreview {
  /** Volume held by the units being consumed. */
  volumeInFlOz: number;
  /** Volume held by the units being produced. */
  volumeOutFlOz: number;
  /**
   * Volume in minus volume out — the raw arithmetic, matching the DB's generated
   * shrinkage_fl_oz column exactly. Positive is beer lost. Can be slightly
   * NEGATIVE on a legitimate build-up (3 x 661 - 1984 = -1); that is the stored
   * rounding showing through, not beer appearing, which is what
   * withinRoundingSlack is for.
   */
  shrinkageFlOz: number;
  shrinkageBbl: number;
  /** Share of the input volume lost, 0–1. Zero when nothing is being transformed. */
  shrinkageRatio: number;
  /** The rounding allowance these counts earn, in fl oz. */
  roundingSlackFlOz: number;
  /**
   * True when the two sides tie to within rounding — there is no real loss OR
   * gain here, just whole-fl-oz storage. The UI reports "no loss" rather than a
   * misleading 0.000 bbl or a negative one.
   */
  withinRoundingSlack: boolean;
  /**
   * True when the units produced would hold MORE than the units consumed did, by
   * more than rounding can explain — beer out of thin air. The DB rejects this
   * outright; the UI blocks submit on it.
   *
   * Equivalent to the DB check failing:
   *   to*toVol <= from*fromVol + slack   <=>   shrinkage >= -slack
   */
  createsVolume: boolean;
  /**
   * Largest whole output count the input volume can actually cover.
   *
   * Solved from the same inequality, with the slack's dependence on the unknown
   * folded in — n grows the allowance as it grows the demand:
   *   n*toVol <= volumeIn + (fromUnits + n)*s
   *   n       <= (volumeIn + fromUnits*s) / (toVol - s)
   */
  maxToUnits: number;
}

export function previewTransform(input: TransformInput): TransformPreview {
  const { fromUnits, fromVolumeFlOz, toUnits, toVolumeFlOz } = input;

  const volumeInFlOz = fromUnits * fromVolumeFlOz;
  const volumeOutFlOz = toUnits * toVolumeFlOz;
  const shrinkageFlOz = volumeInFlOz - volumeOutFlOz;
  const slack = roundingSlackFlOz(fromUnits, toUnits);

  // A unit smaller than the per-unit slack can't bound anything (and would
  // divide by zero or flip sign below) — report 0 rather than handing back
  // Infinity or a negative cap. No real container is under half a fluid ounce.
  const capDenominator = toVolumeFlOz - SLACK_PER_UNIT;

  return {
    volumeInFlOz,
    volumeOutFlOz,
    shrinkageFlOz,
    shrinkageBbl: shrinkageFlOz / BBL_TO_FL_OZ,
    shrinkageRatio: volumeInFlOz > 0 ? shrinkageFlOz / volumeInFlOz : 0,
    roundingSlackFlOz: slack,
    withinRoundingSlack: Math.abs(shrinkageFlOz) <= slack + EPS,
    createsVolume: shrinkageFlOz < -slack - EPS,
    maxToUnits:
      capDenominator > 0
        ? Math.max(0, Math.floor((volumeInFlOz + fromUnits * SLACK_PER_UNIT + EPS) / capDenominator))
        : 0,
  };
}
