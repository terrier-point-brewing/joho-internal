import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import AccountSettings from "./AccountSettings";

export default async function AccountSettingsPage() {
  const session = await getSessionUser();
  if (!session) redirect("/login");
  return <AccountSettings />;
}
