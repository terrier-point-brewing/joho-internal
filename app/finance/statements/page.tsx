import { redirect } from "next/navigation";
export default function StatementsPage() {
  redirect("/finance/financials?statement=pl");
}
