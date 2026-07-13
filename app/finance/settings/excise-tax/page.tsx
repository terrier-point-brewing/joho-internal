import { redirect } from "next/navigation";

export default function ExciseTaxSettingsRedirect() {
  redirect("/finance/settings/tax-filing");
}
