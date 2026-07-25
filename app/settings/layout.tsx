import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import SettingsTabs from "./SettingsTabs";

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const session = await getSessionUser();
  if (!session) redirect("/login");

  return (
    <div className="flex flex-col h-full">
      <SettingsTabs />
      <div className="flex-1 overflow-auto">{children}</div>
    </div>
  );
}
