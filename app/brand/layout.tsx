import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import PageHeader from "@/app/components/PageHeader";
import BrandNav from "./BrandNav";

/**
 * Ops chrome for the /brand area. Reading the published guide is open to any
 * authenticated user; the Canon/History tabs (and their routes) are
 * admin-only per lib/auth.ts — gated here via a server-side session read so
 * non-admins never see the tabs flash in. The children (guide/canon pages)
 * own their own auth checks for their routes too.
 */
export default async function BrandLayout({ children }: { children: React.ReactNode }) {
  const session = await getSessionUser();
  if (!session) redirect("/");
  const isAdmin = session.role === "admin";

  return (
    <div className="flex flex-col h-full bg-canvas text-primary">
      <div className="shrink-0 px-4 sm:px-6 pt-4 sm:pt-8">
        <PageHeader title="Brand" description="Joho brand guide and canon." />
      </div>
      <div className="shrink-0 px-4 sm:px-6">
        <BrandNav isAdmin={isAdmin} />
      </div>
      <main className="px-4 sm:px-6 py-4 sm:py-8">{children}</main>
    </div>
  );
}
