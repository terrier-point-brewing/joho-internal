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
  { href: "/brand/guide", label: "Brand Guide" },
  { href: "/brand/assets", label: "Assets", requires: CAP.brandGuideManage },
  { href: "/brand/releases", label: "Releases", requires: CAP.brandWorkbenchManage },
];
