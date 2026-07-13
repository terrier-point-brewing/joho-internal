import { redirect } from "next/navigation";
export default function BalanceSheetPage() {
  redirect("/finance/financials?statement=balance_sheet");
}
