import { redirect } from "next/navigation";
// Expenses moved under the unified Transactions tab. Keep the old path working.
export default function ExpensesRedirect() {
  redirect("/finance/transactions/expenses");
}
