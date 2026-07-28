import { redirect } from "next/navigation";

// Settings consolidated into the /settings hub. Keep the old path working.
export default function ChartOfAccountsRedirect() {
  redirect("/settings/finance/chart-of-accounts");
}
