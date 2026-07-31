import type { Capability } from "@/lib/auth/capabilities";
import { CAP } from "@/lib/auth/capabilities";

export interface BrandNavEntry {
  href: string;
  label: string;
  /** Hidden unless the viewer holds this capability — canon editing is
   * admin-only today (only the admin role bundle carries any brand.* grant). */
  requires?: Capability;
}

// Brand Guide bundles the rendered guide + canon editor facets + history as
// in-page tabs (app/brand/guide/BrandGuideTabs.tsx); Releases is the beer
// label workbench.
export const BRAND_TABS: BrandNavEntry[] = [
  { href: "/brand/guide", label: "Brand Guide", requires: CAP.brandGuideRead },
  // Each entry now requires exactly what its page gates on, so a visible tab
  // never leads to a redirect. Assets is `read` (looking is the common case);
  // Releases stays `manage` because the label workbench is all writes.
  { href: "/brand/assets", label: "Assets", requires: CAP.brandAssetsRead },
  // Templates sits before Releases because it is upstream of it: a release is
  // launched INTO a template, so the layouts have to exist first.
  { href: "/brand/templates", label: "Templates", requires: CAP.brandTemplatesRead },
  { href: "/brand/releases", label: "Releases", requires: CAP.brandReleasesManage },
];
