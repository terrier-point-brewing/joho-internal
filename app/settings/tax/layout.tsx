import SubNav from "@/app/components/SubNav";
import { TAX_SETTINGS_NAV } from "../nav-config";

/**
 * No group-level gate: the two subtabs need DIFFERENT scopes (finance.tax for
 * the profile, finance.tax.filing for filing config), so each gates itself and
 * the sub-nav hides whichever the caller cannot open.
 */
export default function TaxSettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      <SubNav entries={TAX_SETTINGS_NAV} />
      <div>{children}</div>
    </div>
  );
}
