// Aliased rather than relative (the other six group layouts use `../`), so the
// one place marketing reaches into the settings chassis says so out loud and
// matches the boundary guard's allowlist exactly.
import SettingsGroupShell from "@/app/settings/SettingsGroupShell";
import { requirePage, CAP } from "@/lib/auth";

/**
 * Marketing configuration: the channel logins the publisher posts through.
 *
 * Gated on `marketing.accounts:manage` — the same capability the three account
 * routes enforce — because this screen exists to move credentials, and the
 * section's admission leaf must never carry that authority.
 *
 * One screen, so no sub-nav: a lone sub-tab is chrome that tells you nothing
 * (same call as Catalog).
 */
export default async function MarketingSettingsLayout({ children }: { children: React.ReactNode }) {
  await requirePage(CAP.marketingAccountsManage);
  return <SettingsGroupShell>{children}</SettingsGroupShell>;
}
