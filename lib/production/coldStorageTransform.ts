// lib/production/coldStorageTransform.ts
//
// Pure preview math for a cold-storage transform — breaking N units of one
// packaging variation down into M units of another (a 1/2 keg into sixtels).
//
// This MIRRORS the database's cold_storage_transforms_never_creates_volume
// constraint; it does not replace it. The DB is the enforcer, always. The point
// of computing it here is that an operator should see "that's more beer than you
// started with" while they're still typing, rather than getting a rejected
// request after they commit.
//
// Shrinkage is expected and fine. A 1/2 keg holds 1984 fl oz and a 1/6 holds
// 661, so three sixtels (1983) is a near-perfect run — but foam and line loss
// routinely mean you fill two and lose the rest. That loss is real beer and gets
// recorded rather than rounded away.

import { BBL_TO_FL_OZ } from "@/lib/constants/production";

/** Volume comparisons tolerate this much float dust before calling it a gain. */
const EPS = 1e-6;

export interface TransformInput {
  fromUnits: number;
  fromVolumeFlOz: number;
  toUnits: number;
  toVolumeFlOz: number;
}

export interface TransformPreview {
  /** Volume held by the parent units being cracked. */
  sourceVolumeFlOz: number;
  /** Volume held by the child units produced. */
  producedVolumeFlOz: number;
  shrinkageFlOz: number;
  shrinkageBbl: number;
  /** Share of the source volume lost, 0–1. Zero when nothing is being cracked. */
  shrinkageRatio: number;
  /**
   * True when the child units would hold MORE than the parents did — beer out of
   * thin air. The DB rejects this outright; the UI blocks submit on it.
   */
  createsVolume: boolean;
  /** Largest whole child count the source volume can actually cover. */
  maxToUnits: number;
}

export function previewTransform(input: TransformInput): TransformPreview {
  const { fromUnits, fromVolumeFlOz, toUnits, toVolumeFlOz } = input;

  const sourceVolumeFlOz = fromUnits * fromVolumeFlOz;
  const producedVolumeFlOz = toUnits * toVolumeFlOz;
  const shrinkageFlOz = sourceVolumeFlOz - producedVolumeFlOz;

  return {
    sourceVolumeFlOz,
    producedVolumeFlOz,
    shrinkageFlOz,
    shrinkageBbl: shrinkageFlOz / BBL_TO_FL_OZ,
    shrinkageRatio: sourceVolumeFlOz > 0 ? shrinkageFlOz / sourceVolumeFlOz : 0,
    createsVolume: shrinkageFlOz < -EPS,
    // A child variation with no recorded volume can't bound anything — report 0
    // rather than dividing by zero and handing back Infinity.
    maxToUnits: toVolumeFlOz > 0 ? Math.floor((sourceVolumeFlOz + EPS) / toVolumeFlOz) : 0,
  };
}
