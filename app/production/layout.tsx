import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";

export default async function ProductionLayout({ children }: { children: React.ReactNode }) {
  const session = await getSessionUser();
  if (!session || session.role === "viewer") redirect("/taproom/performance");
  return <>{children}</>;
}
