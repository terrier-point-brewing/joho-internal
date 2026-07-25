import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { CAP, can } from "@/lib/auth";

export default async function TaproomPayrollLayout({ children }: { children: React.ReactNode }) {
  const session = await getSessionUser();
  if (!session || !can(session.grants, CAP.payrollRead.scope, CAP.payrollRead.level)) {
    redirect("/taproom/performance");
  }
  return <>{children}</>;
}
