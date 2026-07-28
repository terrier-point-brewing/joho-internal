import { redirectToFirstReachable, CAP } from "@/lib/auth";

// The hub root. User settings are scope-less, so this effectively always lands
// somewhere — but it is routed through the same reachability check as every
// other index so the rule lives in one place.
export default async function SettingsIndex() {
  return redirectToFirstReachable(
    [{ href: "/settings/user/account", cap: CAP.taproomAccess }],
    "/settings/user/account",
  );
}
