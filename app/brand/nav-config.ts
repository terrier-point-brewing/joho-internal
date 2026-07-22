export interface BrandNavEntry {
  href: string;
  label: string;
  /** Hidden from non-admins — canon editing is admin-only (see lib/auth.ts). */
  adminOnly?: boolean;
}

export const BRAND_TABS: BrandNavEntry[] = [
  { href: "/brand/guide", label: "Guide" },
  { href: "/brand/canon", label: "Canon", adminOnly: true },
  { href: "/brand/canon/history", label: "History", adminOnly: true },
  { href: "/brand/assets", label: "Assets", adminOnly: true },
  { href: "/brand/labels", label: "Labels", adminOnly: true },
];
