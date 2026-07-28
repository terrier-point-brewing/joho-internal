import { requirePage, CAP } from "@/lib/auth";

/**
 * The full-depth payroll surface. The taproom-side view of the same
 * `payroll` scope opens at read — one scope, two depths.
 */
export default async function PayrollLayout({ children }: { children: React.ReactNode }) {
  await requirePage(CAP.payrollManage);
  return <>{children}</>;
}
