import { redirectToFirstReachable, CAP } from "@/lib/auth";

// The two tax settings subtabs gate on different scopes, so a fixed redirect
// would bounce a holder of only one of them.
export default async function TaxSettingsIndex() {
  return redirectToFirstReachable([
    { href: "/settings/tax/profile", cap: CAP.taxManage },
    { href: "/settings/tax/filing", cap: CAP.taxFilingManage },
  ]);
}
