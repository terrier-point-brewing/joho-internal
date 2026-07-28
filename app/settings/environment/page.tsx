import { redirectToFirstReachable, CAP } from "@/lib/auth";

// The four Environment subtabs gate on three unrelated org.* scopes, so a
// fixed redirect would bounce a holder of only one of them.
export default async function EnvironmentSettingsIndex() {
  return redirectToFirstReachable([
    { href: "/settings/environment/business", cap: CAP.businessSettingsManage },
    { href: "/settings/environment/users", cap: CAP.usersManage },
    { href: "/settings/environment/cron", cap: CAP.cronRead },
  ]);
}
