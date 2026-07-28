import SubNav from "@/app/components/SubNav";
import { requirePage, CAP } from "@/lib/auth";
import { PAYROLL_SETTINGS_NAV } from "../nav-config";

/**
 * Payroll configuration. Same `payroll` scope the taproom-side view uses at
 * read/operate — one scope, two depths, not two scopes.
 */
export default async function PayrollSettingsLayout({ children }: { children: React.ReactNode }) {
  await requirePage(CAP.payrollManage);
  return (
    <div className="flex flex-col gap-4">
      <SubNav entries={PAYROLL_SETTINGS_NAV} />
      <div>{children}</div>
    </div>
  );
}
