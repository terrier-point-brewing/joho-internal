import { redirect } from "next/navigation";

export default function FinanceSettingsIndex() {
  redirect("/settings/finance/chart-of-accounts");
}
