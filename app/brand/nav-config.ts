export interface BrandNavEntry {
  href: string;
  label: string;
  /** Hidden from non-admins — canon editing is admin-only (see lib/auth.ts). */
  adminOnly?: boolean;
}

// Brand Guide bundles the rendered guide + canon editor facets + history as
// in-page tabs (app/brand/guide/BrandGuideTabs.tsx); Releases is the beer
// label workbench.
export const BRAND_TABS: BrandNavEntry[] = [
  { href: "/brand/guide", label: "Brand Guide" },
  { href: "/brand/assets", label: "Assets", adminOnly: true },
  { href: "/brand/releases", label: "Releases", adminOnly: true },
];
