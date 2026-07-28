import SettingsGroupShell from "../SettingsGroupShell";
import { USER_SETTINGS_NAV } from "../nav-config";

/**
 * Your own account, on this browser. No capability gate — your own password is
 * a lockout risk to gate, and light/dark is a per-browser display preference.
 * The app-wide reskin control inside Appearance gates itself on
 * org.appearance:manage.
 */
export default function UserSettingsLayout({ children }: { children: React.ReactNode }) {
  return <SettingsGroupShell nav={USER_SETTINGS_NAV}>{children}</SettingsGroupShell>;
}
