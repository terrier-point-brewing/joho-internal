import { redirect } from "next/navigation";
import type { Capability } from "./capabilities";
import { can } from "./resolve";
import { getSessionUser, type Session } from "./session";

/**
 * The page-side twin of requirePermission(). A screen and the APIs it calls
 * should name the same capability, so gating a route group is a one-liner in
 * its layout rather than a hand-rolled getSessionUser + can + redirect trio
 * copied per file — that copying is how page gates and API gates drifted
 * apart in the first place.
 *
 * The default fallback is /settings/account, and deliberately so. Any deny
 * target must be a surface with NO scope, or a user who lacks the section
 * they were bounced into gets redirected again: "/" forwards to
 * /taproom/performance, so sending a taproom-less user there loops forever.
 * The settings hub is session-gated only, which makes it the one guaranteed
 * terminal. Pass an explicit fallback only when the caller can prove the
 * target is reachable for everyone who fails this particular check.
 */
export async function requirePage(
  cap: Capability,
  fallback = "/settings/account",
): Promise<Session> {
  const session = await getSessionUser();
  if (!session) redirect("/login");
  if (!can(session.grants, cap.scope, cap.level)) redirect(fallback);
  return session;
}

/**
 * For a section index that only exists to forward to its first subtab. Now
 * that subtabs gate independently, a fixed redirect can land a user on a
 * screen they cannot open — so pick the first one they can actually reach.
 */
export async function redirectToFirstReachable(
  candidates: { href: string; cap: Capability }[],
  fallback = "/settings/account",
): Promise<never> {
  const session = await getSessionUser();
  if (!session) redirect("/login");
  const hit = candidates.find(({ cap }) => can(session.grants, cap.scope, cap.level));
  redirect(hit?.href ?? fallback);
}
