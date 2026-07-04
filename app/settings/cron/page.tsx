import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import CronMonitor from "./CronMonitor";

export default async function CronSettingsPage() {
  const session = await getSessionUser();
  if (!session || session.role !== "admin") redirect("/settings/account");
  return <CronMonitor />;
}
