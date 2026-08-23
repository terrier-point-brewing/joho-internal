import { redirectToFirstReachable } from "@/lib/auth";
import { CAP } from "@/lib/auth/capabilities";

/**
 * Bare /marketing only exists to forward to the first subtab the viewer can
 * actually open. A fixed redirect would land an Accounts-only holder on a
 * screen they cannot reach, so the candidate list mirrors MARKETING_TABS.
 */
export default async function MarketingIndexPage() {
  return redirectToFirstReachable([
    { href: "/marketing/calendar", cap: CAP.marketingAccess },
    { href: "/marketing/accounts", cap: CAP.marketingAccountsManage },
  ]);
}
