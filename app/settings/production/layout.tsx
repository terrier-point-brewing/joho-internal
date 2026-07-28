import SubNav from "@/app/components/SubNav";
import { requirePage, CAP } from "@/lib/auth";
import { PRODUCTION_SETTINGS_NAV } from "../nav-config";

/**
 * Production-only configuration: deposit terms and export settings. Gated at
 * `manage` per decision #6 — manager keeps their production.settings grant
 * (removing it would lock them out of all of /production) and loses this screen.
 */
export default async function ProductionSettingsLayout({ children }: { children: React.ReactNode }) {
  await requirePage(CAP.productionSettingsManage);
  return (
    <div className="flex flex-col gap-4">
      <SubNav entries={PRODUCTION_SETTINGS_NAV} />
      <div>{children}</div>
    </div>
  );
}
