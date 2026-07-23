import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { getBrandChromeEnabled } from "@/lib/settings/brandChrome.server";
import AppearanceSettings from "./AppearanceSettings";

export default async function AppearanceSettingsPage() {
  const session = await getSessionUser();
  if (!session) redirect("/login");
  const isAdmin = session.role === "admin";
  const brandChromeEnabled = isAdmin ? await getBrandChromeEnabled() : false;
  return <AppearanceSettings isAdmin={isAdmin} brandChromeEnabled={brandChromeEnabled} />;
}
