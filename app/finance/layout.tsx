import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { CAP, can } from "@/lib/auth";

export default async function FinanceLayout({ children }: { children: React.ReactNode }) {
  const session = await getSessionUser();
  if (!session || !can(session.grants, CAP.financeStatementsRead.scope, CAP.financeStatementsRead.level)) {
    redirect("/");
  }

  return <>{children}</>;
}
