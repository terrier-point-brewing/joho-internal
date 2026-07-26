import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { CAP, can } from "@/lib/auth";
import BusinessSettings from "./BusinessSettings";

export default async function BusinessSettingsPage() {
  const session = await getSessionUser();
  if (!session) redirect("/login");
  // Business settings are org-wide and admin-only; non-admins land on Account.
  if (!can(session.grants, CAP.businessSettingsManage.scope, CAP.businessSettingsManage.level)) {
    redirect("/settings/account");
  }
  return <BusinessSettings />;
}
