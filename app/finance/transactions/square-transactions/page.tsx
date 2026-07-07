import { redirect } from "next/navigation";
// POS Transactions was renamed to Orders. Keep the old path working.
export default function SquareTransactionsRedirect() {
  redirect("/finance/transactions/orders");
}
