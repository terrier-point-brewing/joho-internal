import { redirectToFirstReachable, CAP } from "@/lib/auth";

// Subtabs gate independently now, so a fixed redirect to /deposits would bounce
// anyone holding `catalog` but not production.settings:manage.
export default async function SettingsPage() {
  return redirectToFirstReachable([
    { href: "/production/settings/deposits", cap: CAP.productionSettingsManage },
    { href: "/production/settings/square-links", cap: CAP.catalogRead },
  ]);
}
