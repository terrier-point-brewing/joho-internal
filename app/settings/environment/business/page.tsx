import { requirePage, CAP } from "@/lib/auth";
import BusinessSettings from "./BusinessSettings";

// Business settings are org-wide; a denied user lands on the scope-less
// personal settings screen, which is requirePage's default terminal.
export default async function BusinessSettingsPage() {
  await requirePage(CAP.businessSettingsManage);
  return <BusinessSettings />;
}
