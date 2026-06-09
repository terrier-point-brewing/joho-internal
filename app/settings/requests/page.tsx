import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import AccessRequests from "./AccessRequests";

export default async function AccessRequestsPage() {
  const session = await getSessionUser();
  if (!session || session.role !== "admin") redirect("/settings/account");
  return <AccessRequests />;
}
