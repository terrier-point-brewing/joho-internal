import { redirect } from "next/navigation";

// The old CSV import screen; uploading is part of Chart of Accounts now.
// Was hopping via /finance/settings/chart-of-accounts, a redirect to a
// redirect — see the sibling note in ../chart-of-accounts/page.tsx.
export default function OldImportPage() {
  redirect("/settings/finance/chart-of-accounts");
}
