import { redirect } from "next/navigation";
export default function TransactionsPage() {
  redirect("/finance/transactions/orders");
}
