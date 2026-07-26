import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { CAP, can } from "@/lib/auth";
import CronMonitor from "./CronMonitor";

export default async function CronSettingsPage() {
  const session = await getSessionUser();
  if (!session || !can(session.grants, CAP.cronRead.scope, CAP.cronRead.level)) {
    redirect("/settings/account");
  }
  return <CronMonitor />;
}
