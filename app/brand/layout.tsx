import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { getBrandChromeEnabled } from "@/lib/settings/brandChrome.server";
import PageHeader from "@/app/components/PageHeader";
import BrandChromeToggle from "@/app/components/brand/BrandChromeToggle";
import BrandNav from "./BrandNav";

/**
 * Ops chrome for the /brand area. The whole area is admin-only for now — the
 * feature is WIP and not yet exposed to regular users — so non-admins are
 * redirected out here via a server-side session read (nav links are hidden
 * too, but this guards direct navigation). Once it ships more widely the
 * Guide can reopen to all authenticated users while the Canon/History/Assets/
 * Labels tabs stay admin-only per lib/auth.ts.
 */
export default async function BrandLayout({ children }: { children: React.ReactNode }) {
  const session = await getSessionUser();
  if (!session) redirect("/");
  const isAdmin = session.role === "admin";
  if (!isAdmin) redirect("/");
  const brandChromeEnabled = await getBrandChromeEnabled();

  return (
    <div className="flex flex-col h-full bg-canvas text-primary">
      <div className="shrink-0 px-4 sm:px-6 pt-4 sm:pt-8 flex items-start justify-between gap-4">
        <PageHeader title="Brand" description="Joho brand guide and canon." />
        {isAdmin && <BrandChromeToggle initialEnabled={brandChromeEnabled} />}
      </div>
      <div className="shrink-0 px-4 sm:px-6">
        <BrandNav isAdmin={isAdmin} />
      </div>
      <main className="px-4 sm:px-6 py-4 sm:py-8">{children}</main>
    </div>
  );
}
