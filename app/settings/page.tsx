import { redirectToFirstReachable, CAP } from "@/lib/auth";

// The hub root. Account is scope-less, so this effectively always lands
// somewhere — but it is routed through the same reachability check as every
// other index so the rule lives in one place.
export default async function SettingsIndex() {
  return redirectToFirstReachable([{ href: "/settings/account", cap: CAP.taproomAccess }], "/settings/account");
}
