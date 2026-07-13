import { redirect } from "next/navigation";
export default function PLPage() {
  redirect("/finance/financials?statement=pl");
}
