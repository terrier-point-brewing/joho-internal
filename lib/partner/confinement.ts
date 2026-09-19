/**
 * Everything an external partner session may touch. An allowlist, so a route
 * added tomorrow is closed to partners until someone opens it here on purpose.
 * Read by proxy.ts, which sees every request before any page or route does.
 */
const PARTNER_PREFIXES = ["/partner", "/api/partner", "/api/auth/", "/auth/"];

export function partnerMayReach(pathname: string): boolean {
  return PARTNER_PREFIXES.some((p) =>
    p.endsWith("/") ? pathname.startsWith(p) : pathname === p || pathname.startsWith(p + "/"));
}
