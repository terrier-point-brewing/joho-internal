import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { CAP, can } from "@/lib/auth";

/**
 * Ops chrome for the /brand area. The whole area is admin-only for now — the
 * feature is WIP and not yet exposed to regular users — so non-admins are
 * redirected out here via a server-side session read (nav links are hidden
 * too, but this guards direct navigation). Only the admin role bundle
 * currently carries any brand.* grant, so gating on brand.guide read
 * reproduces "admin-only" exactly. Once it ships more widely the Brand Guide
 * can reopen to all authenticated users while its editor tabs and the
 * Assets/Releases tabs stay gated on brand.guide/workbench manage.
 *
 * Section nav (Brand Guide / Assets / Releases) lives in the app sidebar, so
 * this layout is just the capability gate + a full-height shell. Each page
 * owns its own header/scroll structure (the app-wide `flex flex-col h-full` →
 * fixed header → `flex-1 overflow-auto` pattern), so the layout adds no
 * padding of its own. The light/dark + brand-skin controls live in
 * Settings → Appearance.
 */
export default async function BrandLayout({ children }: { children: React.ReactNode }) {
  const session = await getSessionUser();
  if (!session) redirect("/");
  const canAccessBrand = can(session.grants, CAP.brandAccess.scope, CAP.brandAccess.level);
  if (!canAccessBrand) redirect("/");

  return <div className="flex flex-col h-full bg-canvas text-primary">{children}</div>;
}
