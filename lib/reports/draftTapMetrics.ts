import { BBL_TO_FL_OZ } from "@/lib/constants/production";

/**
 * Reserve beer (fl oz) sitting in cold-storage swap kegs for a tap: the count of
 * that tap's configured swap keg on hand times the full-keg recount volume.
 * Zero when the tap has no swap keg configured or nothing is on hand.
 */
export function swapReserveFlOz(swapKegsOnHand: number, swapVolumeFlOz: number | null): number {
  if (!swapVolumeFlOz || swapVolumeFlOz <= 0 || swapKegsOnHand <= 0) return 0;
  return swapKegsOnHand * swapVolumeFlOz;
}

/**
 * Total BBL on hand for a tap = beer currently on tap (fl oz) plus the reserve
 * swap kegs waiting in cold storage (fl oz), converted to barrels.
 */
export function tapBblOnHand(draftFlOz: number, reserveFlOz: number): number {
  return (draftFlOz + reserveFlOz) / BBL_TO_FL_OZ;
}
