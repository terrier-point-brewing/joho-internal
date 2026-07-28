import SettingsGroupShell from "../SettingsGroupShell";
import { TAX_SETTINGS_NAV } from "../nav-config";

/**
 * No group-level gate: the two subtabs need DIFFERENT scopes (finance.tax for
 * the profile, finance.tax.filing for filing config), so each gates itself and
 * the sub-nav hides whichever the caller cannot open.
 */
export default function TaxSettingsLayout({ children }: { children: React.ReactNode }) {
  return <SettingsGroupShell nav={TAX_SETTINGS_NAV}>{children}</SettingsGroupShell>;
}
