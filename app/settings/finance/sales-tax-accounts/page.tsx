import { redirect } from "next/navigation";

// Folded into the single GL Mapping screen. Kept so links handed out while
// this was its own sub-tab still land somewhere useful; safe to delete once
// no one is bookmarking the old path.
export default function SalesTaxAccountsRedirect() {
  redirect("/settings/finance/gl-mapping?tab=sales-tax");
}
