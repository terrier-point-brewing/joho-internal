import type { Capability } from "@/lib/auth/capabilities";
import { CAP } from "@/lib/auth/capabilities";

/**
 * Imported by app/components/NavBar.tsx, which is a client component — so this
 * file must reach for @/lib/auth/capabilities directly and never the
 * @/lib/auth barrel, which pulls next/headers into the client bundle.
 */
export interface MarketingNavEntry {
  href: string;
  label: string;
  /** Hidden unless the viewer holds this capability. */
  requires?: Capability;
}

/**
 * Two subtabs, and only two. Calendar is the section's home; Accounts is where
 * a channel login gets connected.
 *
 * Each entry requires EXACTLY what its page gates on — a visible tab that
 * leads to a redirect is the specific bug this rule exists to prevent. Accounts
 * therefore sits at `manage`, matching CAP.marketingAccountsManage, so someone
 * holding only `marketing.access` sees Calendar alone.
 */
export const MARKETING_TABS: MarketingNavEntry[] = [
  { href: "/marketing/calendar", label: "Calendar", requires: CAP.marketingAccess },
  { href: "/marketing/accounts", label: "Accounts", requires: CAP.marketingAccountsManage },
];
