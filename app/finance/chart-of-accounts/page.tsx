import { redirect } from "next/navigation";

// Points straight at the settings hub. This used to hop via
// /finance/settings/chart-of-accounts, which was itself only a redirect — two
// round trips to reach one page, and the reason that whole tree outlived the
// settings consolidation that was supposed to retire it.
export default function CoARedirect() {
  redirect("/settings/finance/chart-of-accounts");
}
