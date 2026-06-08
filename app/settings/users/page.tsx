import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import UserManagement from "./UserManagement";

export default async function UsersSettingsPage() {
  const session = await getSessionUser();
  if (!session || session.role !== "admin") redirect("/");

  return <UserManagement />;
}
