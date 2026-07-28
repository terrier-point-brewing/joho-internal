import SettingsGroupShell from "../SettingsGroupShell";
import { requirePage, CAP } from "@/lib/auth";
import { PRODUCTION_SETTINGS_NAV } from "../nav-config";

/**
 * Production-only configuration: deposit terms and export settings. Gated at
 * `manage` per decision #6 — manager keeps their production.settings grant
 * (removing it would lock them out of all of /production) and loses this screen.
 */
export default async function ProductionSettingsLayout({ children }: { children: React.ReactNode }) {
  await requirePage(CAP.productionSettingsManage);
  return <SettingsGroupShell nav={PRODUCTION_SETTINGS_NAV}>{children}</SettingsGroupShell>;
}
