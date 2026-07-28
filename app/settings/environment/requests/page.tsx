import { requirePage, CAP } from "@/lib/auth";
import AccessRequests from "./AccessRequests";

export default async function AccessRequestsPage() {
  await requirePage(CAP.usersManage);
  return <AccessRequests />;
}
