import SettingsGroupShell from "../SettingsGroupShell";
import { requirePage, CAP } from "@/lib/auth";
import { PAYROLL_SETTINGS_NAV } from "../nav-config";

/**
 * Payroll configuration. Same `payroll` scope the taproom-side view uses at
 * read/operate — one scope, two depths, not two scopes.
 */
export default async function PayrollSettingsLayout({ children }: { children: React.ReactNode }) {
  await requirePage(CAP.payrollManage);
  return <SettingsGroupShell nav={PAYROLL_SETTINGS_NAV}>{children}</SettingsGroupShell>;
}
