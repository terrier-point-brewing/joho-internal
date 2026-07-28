import SettingsGroupShell from "../SettingsGroupShell";
import { ENVIRONMENT_SETTINGS_NAV } from "../nav-config";

/**
 * The `org.*` scope family: how this deployment is configured, as opposed to
 * how any one domain behaves. No group-level gate — the four subtabs need
 * three unrelated scopes (org.business, org.users, org.jobs), so each gates
 * itself and the sub-nav hides whichever the caller cannot open.
 */
export default function EnvironmentSettingsLayout({ children }: { children: React.ReactNode }) {
  return <SettingsGroupShell nav={ENVIRONMENT_SETTINGS_NAV}>{children}</SettingsGroupShell>;
}
