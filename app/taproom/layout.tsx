import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { CAP, can } from "@/lib/auth";

/**
 * Taproom admission. This section had no server-side gate at all — the one
 * section relying purely on API-layer enforcement, so `/taproom/performance`
 * and `/taproom/targets` rendered for anyone with a session.
 *
 * Deny sends to /settings/user/account, NOT to "/" — app/page.tsx redirects "/" to
 * /taproom/performance, so bouncing there would loop forever for a user
 * carrying `taproom.access: none`. That revoke is a documented use of the
 * access leaf, so the terminal has to be a surface with no scope at all, and
 * the settings hub is session-gated only.
 */
export default async function TaproomLayout({ children }: { children: React.ReactNode }) {
  const session = await getSessionUser();
  if (!session || !can(session.grants, CAP.taproomAccess.scope, CAP.taproomAccess.level)) {
    redirect("/settings/user/account");
  }
  return <>{children}</>;
}
