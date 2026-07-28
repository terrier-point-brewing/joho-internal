import SettingsGroupShell from "../SettingsGroupShell";
import { requirePage, CAP } from "@/lib/auth";

/**
 * Square Item Mappings is `catalog`, not `production.settings` — the same
 * component used to answer to two different scopes depending on the route
 * it was mounted at.
 *
 * One screen, so no sub-nav: a lone sub-tab is chrome that tells you nothing.
 */
export default async function SquareLinksLayout({ children }: { children: React.ReactNode }) {
  await requirePage(CAP.catalogRead);
  return <SettingsGroupShell>{children}</SettingsGroupShell>;
}
