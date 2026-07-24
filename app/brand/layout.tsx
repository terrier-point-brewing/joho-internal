import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";

/**
 * Ops chrome for the /brand area. The whole area is admin-only for now — the
 * feature is WIP and not yet exposed to regular users — so non-admins are
 * redirected out here via a server-side session read (nav links are hidden
 * too, but this guards direct navigation). Once it ships more widely the
 * Brand Guide can reopen to all authenticated users while its editor tabs and
 * the Assets/Releases tabs stay admin-only per lib/auth.ts.
 *
 * Section nav (Brand Guide / Assets / Releases) lives in the app sidebar, so
 * this layout is just the admin gate + a full-bleed shell. The light/dark +
 * brand-skin controls live in Settings → Appearance.
 */
export default async function BrandLayout({ children }: { children: React.ReactNode }) {
  const session = await getSessionUser();
  if (!session) redirect("/");
  const isAdmin = session.role === "admin";
  if (!isAdmin) redirect("/");

  return (
    <div className="flex flex-col h-full bg-canvas text-primary">
      <main className="px-4 sm:px-6 py-4 sm:py-8">{children}</main>
    </div>
  );
}
