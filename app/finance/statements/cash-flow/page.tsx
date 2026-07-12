import { redirect } from "next/navigation";
export default function CashFlowPage() {
  redirect("/finance/financials?statement=cash_flow");
}
