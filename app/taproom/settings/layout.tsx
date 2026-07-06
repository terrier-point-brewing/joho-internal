import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import SubNav from "@/app/components/SubNav";
import PageHeader from "@/app/components/PageHeader";
import { TAPROOM_NAV, TAPROOM_SETTINGS_NAV } from "@/app/taproom/nav-config";

export default async function TaproomSettingsLayout({ children }: { children: React.ReactNode }) {
  const session = await getSessionUser();
  // Settings modules are for taproom managers (and admins); everyone else is
  // bounced back to the performance dashboard.
  if (!session || (session.role !== "manager" && session.role !== "admin")) {
    redirect("/taproom/performance");
  }

  return (
    <main className="px-4 sm:px-6 py-4 sm:py-8">
      <SubNav entries={TAPROOM_NAV} mobile />
      <PageHeader title="Settings" description="Manage taproom-facing configuration without leaving Taproom Management" />
      <SubNav entries={TAPROOM_SETTINGS_NAV} sticky />
      <div className="mt-4">{children}</div>
    </main>
  );
}
