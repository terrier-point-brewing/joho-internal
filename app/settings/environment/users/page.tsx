import { requirePage, CAP } from "@/lib/auth";
import UserManagement from "./UserManagement";

export default async function UsersSettingsPage() {
  await requirePage(CAP.usersManage);
  return <UserManagement />;
}
