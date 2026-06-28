import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";

export default async function TaproomPayrollLayout({ children }: { children: React.ReactNode }) {
  const session = await getSessionUser();
  if (!session || (session.role !== "manager" && session.role !== "admin")) {
    redirect("/taproom/performance");
  }
  return <>{children}</>;
}
