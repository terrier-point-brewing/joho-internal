import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { CAP, can } from "@/lib/auth";
import UserManagement from "./UserManagement";

export default async function UsersSettingsPage() {
  const session = await getSessionUser();
  if (!session || !can(session.grants, CAP.usersManage.scope, CAP.usersManage.level)) {
    redirect("/settings/account");
  }
  return <UserManagement />;
}
