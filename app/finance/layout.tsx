import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";

export default async function FinanceLayout({ children }: { children: React.ReactNode }) {
  const session = await getSessionUser();
  if (!session || session.role !== "admin") redirect("/");

  return <>{children}</>;
}
