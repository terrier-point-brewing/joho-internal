import { requirePage, CAP } from "@/lib/auth";
import CronMonitor from "./CronMonitor";

export default async function CronSettingsPage() {
  await requirePage(CAP.cronRead);
  return <CronMonitor />;
}
