"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { useUserRole, usePermissions } from "@/lib/hooks/useUserRole";
import PartnerBar from "@/app/partner/PartnerBar";
import { usePendingAccessRequestCount } from "@/lib/hooks/useAccessRequests";
import { CAP } from "@/lib/auth/capabilities";
import { navEntryVisible } from "./SubNav";
import { Modal } from "./ui/Modal";
import ConfirmDialog from "./ui/ConfirmDialog";
import { FINANCE_NAV } from "@/app/finance/nav-config";
import { TAPROOM_NAV } from "@/app/taproom/nav-config";
import { PRODUCTION_NAV } from "@/app/production/nav-config";
import { BRAND_TABS } from "@/app/brand/nav-config";
// The single allowlisted crossing of the marketing boundary
// (scripts/check-marketing-boundary.mjs). Every section's sidebar block imports
// that section's nav config, and without this one the sidebar cannot render
// Marketing at all.
import { MARKETING_TABS } from "@/app/marketing/nav-config";
import { SETTINGS_GROUPS } from "@/app/settings/nav-config";

const ROLE_LABELS: Record<string, string> = {
  viewer: "Viewer", brewer: "Brewer", manager: "Manager", admin: "Admin",
};

const STORAGE_KEY = "tpb-sidebar-collapsed";

// ── Icons ──────────────────────────────────────────────────────────────────────
// Lucide (MIT), thin 1.75px strokes to match the rest of the chrome. Every nav
// glyph is defined once here; the sidebar, the collapsed rail and the phone
// bottom nav all draw from this list.

import {
  Beer, Calendar, Ellipsis, Factory, House, LogOut, Settings, Sparkles, Wallet,
} from "lucide-react";

const NAV_ICON = { size: 20, strokeWidth: 1.75, "aria-hidden": true } as const;
const TaproomIcon    = () => <Beer {...NAV_ICON} />;
const ProductionIcon = () => <Factory {...NAV_ICON} />;
const FinanceIcon    = () => <Wallet {...NAV_ICON} />;
const BrandIcon      = () => <Sparkles {...NAV_ICON} />;
const MarketingIcon  = () => <Calendar {...NAV_ICON} />;
const HomeIcon       = () => <House {...NAV_ICON} />;
const SettingsIcon   = () => <Settings {...NAV_ICON} />;
const MoreIcon       = () => <Ellipsis {...NAV_ICON} />;
const LogoutIcon     = () => <LogOut size={14} strokeWidth={1.75} aria-hidden />;

// ── Component ──────────────────────────────────────────────────────────────────

export default function NavBar() {
  const pathname = usePathname();

  const { role, user, loading, isPartner } = useUserRole();
  const { can } = usePermissions();
  const pendingRequests = usePendingAccessRequestCount();

  const [collapsed, setCollapsed] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [signOutOpen, setSignOutOpen] = useState(false);

  // Read persisted state after hydration to avoid server/client mismatch
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (stored === "true") setCollapsed(true);
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, String(collapsed));
  }, [collapsed]);

  if (pathname === "/login" || pathname.startsWith("/auth/")) return null;

  async function handleLogout() {
    const supabase = createSupabaseBrowserClient();
    await supabase.auth.signOut();
    window.location.href = "/login";
  }

  // An external partner gets no staff navigation at all — not a filtered
  // sidebar, none. Just a slim top bar; the portal is one page.
  if (isPartner) return <PartnerBar email={user?.email ?? null} onSignOut={handleLogout} />;

  const isProduction = pathname === "/production" || pathname.startsWith("/production/");
  const isTaproom    = pathname === "/taproom" || pathname.startsWith("/taproom/");
  const isFinance    = pathname === "/finance"    || pathname.startsWith("/finance/");
  const isBrand      = pathname === "/brand"      || pathname.startsWith("/brand/");
  const isMarketing  = pathname === "/marketing"  || pathname.startsWith("/marketing/");
  const isSettings   = pathname.startsWith("/settings");
  const isHome       = pathname === "/home" || pathname.startsWith("/home/");

  // Derived permissions — only evaluated after loading is done. Reuses the
  // same capabilities their respective layouts gate on, so NavBar visibility
  // and the server-side redirect can never drift apart.
  const canAccessProduction = can(CAP.productionAccess);
  const canAccessBrand      = can(CAP.brandAccess);
  const canAccessFinance    = can(CAP.financeAccess);
  const canAccessMarketing  = can(CAP.marketingAccess);

  const subtabCls = (active: boolean) =>
    `px-2 py-1.5 rounded text-xs font-medium transition-colors ${
      active
        ? "text-accent bg-accent-muted/20"
        : "text-muted hover:text-body hover:bg-surface-mid/40"
    }`;

  return (
    <>
      {/* ── Desktop sidebar ─────────────────────────────────────────────────── */}
      <aside
        className={`hidden md:flex shrink-0 bg-surface border-r border-line flex-col h-screen sticky top-0 transition-all duration-200 ${
          collapsed ? "w-10" : "w-48"
        }`}
      >
        {/* Logo / toggle row */}
        <div className={`flex items-center border-b border-line ${collapsed ? "justify-center px-0 py-5" : "px-4 py-5"}`}>
          {/* The wordmark is the way into the Home alert center — the one page
              that lists everything needing a decision, across every section. */}
          {!collapsed && (
            <Link
              href="/home"
              title="Home — alerts and things to do"
              className={`text-base font-bold tracking-wide flex-1 transition-colors ${isHome ? "text-accent" : "text-primary hover:text-accent"}`}
            >
              TPB
            </Link>
          )}
          <button
            onClick={() => setCollapsed((c) => !c)}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="text-muted hover:text-strong transition-colors p-1 rounded hover:bg-surface-mid/60"
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? (
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M5 3l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M9 3L5 7l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            )}
          </button>
        </div>

        {/* Nav — wait for role before rendering gated items */}
        {!collapsed && (
          <nav className="flex flex-col gap-0.5 p-2">
            {/* Taproom — everyone */}
            <Link
              href="/taproom/performance"
              className={`px-3 py-2 rounded text-sm font-medium transition-colors ${
                isTaproom ? "bg-surface-mid text-primary" : "text-secondary hover:text-strong hover:bg-surface-mid/50"
              }`}
            >
              Taproom Management
            </Link>
            {isTaproom && (
              <div className="mt-1 ml-2 flex flex-col gap-0.5 border-l border-line pl-2">
                {TAPROOM_NAV.filter((e) => !e.requires || can(e.requires)).map(({ href, label }) => (
                  <Link key={href} href={href} className={subtabCls(pathname.startsWith(href))}>
                    {label}
                  </Link>
                ))}
              </div>
            )}

            {/* Role-gated items — render only once role is known */}
            {!loading && (
              <>
                {canAccessProduction && (
                  <>
                    <Link
                      href="/production/intake"
                      className={`px-3 py-2 rounded text-sm font-medium transition-colors ${
                        isProduction ? "bg-surface-mid text-primary" : "text-secondary hover:text-strong hover:bg-surface-mid/50"
                      }`}
                    >
                      Production
                    </Link>
                    {isProduction && (
                      <div className="mt-1 ml-2 flex flex-col gap-0.5 border-l border-line pl-2">
                        {PRODUCTION_NAV.map(({ href, label }) => (
                          <Link key={href} href={href} className={subtabCls(pathname.startsWith(href))}>
                            {label}
                          </Link>
                        ))}
                      </div>
                    )}
                  </>
                )}

                {/* Brand — WIP, admin-only until ready for regular users */}
                {canAccessBrand && (
                  <>
                    <Link
                      href="/brand/guide"
                      className={`px-3 py-2 rounded text-sm font-medium transition-colors ${
                        isBrand ? "bg-surface-mid text-primary" : "text-secondary hover:text-strong hover:bg-surface-mid/50"
                      }`}
                    >
                      Brand
                    </Link>
                    {isBrand && (
                      <div className="mt-1 ml-2 flex flex-col gap-0.5 border-l border-line pl-2">
                        {BRAND_TABS.filter((e) => !e.requires || can(e.requires)).map(({ href, label }) => (
                          <Link key={href} href={href} className={subtabCls(pathname === href || pathname.startsWith(href + "/"))}>
                            {label}
                          </Link>
                        ))}
                      </div>
                    )}
                  </>
                )}

                {/* Marketing — the calendar + the channels it publishes through */}
                {canAccessMarketing && (
                  <>
                    <Link
                      href="/marketing/calendar"
                      className={`px-3 py-2 rounded text-sm font-medium transition-colors ${
                        isMarketing ? "bg-surface-mid text-primary" : "text-secondary hover:text-strong hover:bg-surface-mid/50"
                      }`}
                    >
                      Marketing
                    </Link>
                    {isMarketing && (
                      <div className="mt-1 ml-2 flex flex-col gap-0.5 border-l border-line pl-2">
                        {MARKETING_TABS.filter((e) => navEntryVisible(e, can)).map(({ href, label }) => (
                          <Link key={href} href={href} className={subtabCls(pathname === href || pathname.startsWith(href + "/"))}>
                            {label}
                          </Link>
                        ))}
                      </div>
                    )}
                  </>
                )}

                {canAccessFinance && (
                  <>
                    <Link
                      href="/finance/financials"
                      className={`px-3 py-2 rounded text-sm font-medium transition-colors ${
                        isFinance ? "bg-surface-mid text-primary" : "text-secondary hover:text-strong hover:bg-surface-mid/50"
                      }`}
                    >
                      Finance
                    </Link>
                    {isFinance && (
                      <div className="mt-1 ml-2 flex flex-col gap-0.5 border-l border-line pl-2">
                        {FINANCE_NAV.map(({ href, label, match, also }) => (
                          <Link key={href} href={href} className={subtabCls(
                            pathname.startsWith(match ?? href) || (also != null && pathname.startsWith(also))
                          )}>
                            {label}
                          </Link>
                        ))}
                      </div>
                    )}

                  </>
                )}

                <Link
                  href="/settings/user/account"
                  className={`px-3 py-2 rounded text-sm font-medium transition-colors flex items-center gap-1.5 ${
                    isSettings ? "bg-surface-mid text-primary" : "text-secondary hover:text-strong hover:bg-surface-mid/50"
                  }`}
                >
                  Settings
                  {!isSettings && pendingRequests > 0 && <PendingBadge count={pendingRequests} />}
                </Link>
                {isSettings && (
                  <div className="mt-1 ml-2 flex flex-col gap-0.5 border-l border-line pl-2">
                    {SETTINGS_GROUPS.filter((e) => navEntryVisible(e, can)).map(({ href, label }) => (
                      <Link
                        key={href}
                        href={href}
                        className={`${subtabCls(pathname === href || pathname.startsWith(href + "/"))} flex items-center gap-1.5`}
                      >
                        {label}
                        {href === "/settings/environment" && pendingRequests > 0 && (
                          <PendingBadge count={pendingRequests} />
                        )}
                      </Link>
                    ))}
                  </div>
                )}
              </>
            )}
          </nav>
        )}

        {/* Collapsed: icon-only nav */}
        {collapsed && (
          <nav className="flex flex-col items-center gap-1 p-1 pt-2">
            <Link href="/home" title="Home — alerts and things to do"
              className={`w-7 h-7 flex items-center justify-center rounded transition-colors ${isHome ? "bg-surface-mid text-accent" : "text-faint hover:text-body hover:bg-surface-mid/50"}`}>
              <HomeIcon />
            </Link>
            <Link href="/taproom/performance" title="Taproom Management"
              className={`w-7 h-7 flex items-center justify-center rounded transition-colors ${isTaproom ? "bg-surface-mid text-accent" : "text-faint hover:text-body hover:bg-surface-mid/50"}`}>
              <TaproomIcon />
            </Link>
            {!loading && canAccessProduction && (
              <Link href="/production/intake" title="Production"
                className={`w-7 h-7 flex items-center justify-center rounded transition-colors ${isProduction ? "bg-surface-mid text-accent" : "text-faint hover:text-body hover:bg-surface-mid/50"}`}>
                <ProductionIcon />
              </Link>
            )}
            {!loading && canAccessBrand && (
              <Link href="/brand/guide" title="Brand"
                className={`w-7 h-7 flex items-center justify-center rounded transition-colors ${isBrand ? "bg-surface-mid text-accent" : "text-faint hover:text-body hover:bg-surface-mid/50"}`}>
                <BrandIcon />
              </Link>
            )}
            {!loading && canAccessMarketing && (
              <Link href="/marketing/calendar" title="Marketing"
                className={`w-7 h-7 flex items-center justify-center rounded transition-colors ${isMarketing ? "bg-surface-mid text-accent" : "text-faint hover:text-body hover:bg-surface-mid/50"}`}>
                <MarketingIcon />
              </Link>
            )}
            {!loading && canAccessFinance && (
              <Link href="/finance/financials" title="Finance"
                className={`w-7 h-7 flex items-center justify-center rounded transition-colors ${isFinance ? "bg-surface-mid text-accent" : "text-faint hover:text-body hover:bg-surface-mid/50"}`}>
                <FinanceIcon />
              </Link>
            )}
            {!loading && (
              <Link href="/settings/user/account" title="Settings"
                className={`w-7 h-7 flex items-center justify-center rounded transition-colors ${isSettings ? "bg-surface-mid text-accent" : "text-faint hover:text-body hover:bg-surface-mid/50"}`}>
                <SettingsIcon />
              </Link>
            )}
          </nav>
        )}

        {/* Account info + logout */}
        <div className="mt-auto border-t border-line p-2 flex flex-col gap-1">
          {!collapsed && !loading && user && (
            <div className="px-2 py-1.5">
              <div className="text-xs text-body truncate">{user.email}</div>
              <div className="text-[10px] text-faint mt-0.5">
                {role ? ROLE_LABELS[role] ?? role : ""}
              </div>
            </div>
          )}
          {collapsed ? (
            <button onClick={handleLogout} title="Sign out"
              className="w-7 h-7 flex items-center justify-center rounded text-faint hover:text-danger hover:bg-surface-mid/50 transition-colors mx-auto">
              <LogoutIcon />
            </button>
          ) : (
            <button onClick={handleLogout}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs text-muted hover:text-danger hover:bg-surface-mid/40 transition-colors">
              <LogoutIcon />
              Sign out
            </button>
          )}
        </div>
      </aside>

      {/* ── Mobile top bar ───────────────────────────────────────────────────── */}
      {/* The account block is the way to sign out on a phone: tapping it asks
          first (ConfirmDialog), since a 44px target next to the thumb should
          never end a session by accident. Sign out used to be a bottom-nav
          tab — it isn't a destination, and the bar had seven items. */}
      <div className="md:hidden fixed top-0 inset-x-0 z-50 bg-surface border-b border-line flex items-center justify-between px-4 h-11">
        <Link href="/home" className={`text-sm font-bold tracking-wide ${isHome ? "text-accent" : "text-primary"}`}>TPB</Link>
        {!loading && user && (
          <button
            type="button"
            onClick={() => setSignOutOpen(true)}
            aria-label={`Account ${user.email}. Sign out`}
            className="text-right -mr-2 px-2 h-full"
          >
            <div className="text-xs text-body truncate max-w-[200px]">{user.email}</div>
            <div className="text-2xs text-faint">{role ? ROLE_LABELS[role] ?? role : ""}</div>
          </button>
        )}
      </div>
      {signOutOpen && (
        <ConfirmDialog
          title="Sign out?"
          message={`You are signed in as ${user?.email ?? "this account"}.`}
          confirmLabel="Sign out"
          tone="primary"
          onConfirm={handleLogout}
          onCancel={() => setSignOutOpen(false)}
        />
      )}

      {/* ── Mobile bottom nav ────────────────────────────────────────────────── */}
      {/* Height is --mobile-nav-h (globals.css), which is also what the content
          pane reserves; keep the two in step. At most five items (HIG): when the
          role can see more sections, the fifth slot is "More", a sheet listing
          the rest. The safe-area padding lifts the tap targets off the home
          indicator without changing what the content pane reserves. */}
      {(() => {
        // Listed in phone priority: the daily sections keep a slot, Brand and
        // Marketing are the first to fold into "More" when a role sees all six.
        const sections: { href: string; active: boolean; label: string; icon: React.ReactNode }[] = [
          { href: "/taproom/performance", active: isTaproom, label: "Taproom", icon: <TaproomIcon /> },
          ...(!loading && canAccessProduction ? [{ href: "/production/intake", active: isProduction, label: "Production", icon: <ProductionIcon /> }] : []),
          ...(!loading && canAccessFinance ? [{ href: "/finance/financials", active: isFinance, label: "Finance", icon: <FinanceIcon /> }] : []),
          ...(!loading ? [{ href: "/settings/user/account", active: isSettings, label: "Settings", icon: <SettingsIcon /> }] : []),
          ...(!loading && canAccessBrand ? [{ href: "/brand/guide", active: isBrand, label: "Brand", icon: <BrandIcon /> }] : []),
          ...(!loading && canAccessMarketing ? [{ href: "/marketing/calendar", active: isMarketing, label: "Marketing", icon: <MarketingIcon /> }] : []),
        ];
        const MAX = 5;
        const overflow = sections.length > MAX;
        const shown = overflow ? sections.slice(0, MAX - 1) : sections;
        const rest = overflow ? sections.slice(MAX - 1) : [];
        const restActive = rest.some((x) => x.active);
        return (
          <>
            <nav
              aria-label="Sections"
              className="md:hidden fixed bottom-0 inset-x-0 z-50 bg-surface border-t border-line flex items-stretch h-[var(--mobile-nav-h)] box-content pb-[env(safe-area-inset-bottom,0px)]"
            >
              {shown.map((x) => (
                <MobileNavItem key={x.href} href={x.href} active={x.active} label={x.label}>
                  {x.icon}
                </MobileNavItem>
              ))}
              {overflow && (
                <button
                  type="button"
                  onClick={() => setMoreOpen(true)}
                  aria-haspopup="dialog"
                  aria-expanded={moreOpen}
                  className={`flex-1 flex flex-col items-center justify-center gap-1 transition-colors ${
                    restActive ? "text-accent" : "text-muted"
                  }`}
                >
                  <MoreIcon />
                  <span className="text-2xs font-medium leading-none">More</span>
                </button>
              )}
            </nav>
            {moreOpen && (
              <Modal title="More" onClose={() => setMoreOpen(false)}>
                <nav aria-label="More sections" className="flex flex-col gap-1 -m-2">
                  {rest.map((x) => (
                    <Link
                      key={x.href}
                      href={x.href}
                      onClick={() => setMoreOpen(false)}
                      className={`flex items-center gap-3 px-3 py-3 rounded text-sm font-medium transition-colors ${
                        x.active ? "bg-surface-mid text-accent" : "text-secondary hover:text-strong hover:bg-surface-mid/50"
                      }`}
                    >
                      {x.icon}
                      {x.label}
                    </Link>
                  ))}
                </nav>
              </Modal>
            )}
          </>
        );
      })()}
    </>
  );
}

/**
 * Pending access-request count. Rides the Environment settings group, and the
 * Settings entry itself while that group is collapsed, so an admin sees the
 * count without having to be inside settings already.
 */
function PendingBadge({ count }: { count: number }) {
  return (
    <span className="text-xs bg-accent-emphasis text-canvas font-bold rounded-full px-1.5 py-0.5 leading-none">
      {count}
    </span>
  );
}

function MobileNavItem({
  href, active, label, children,
}: {
  href: string;
  active: boolean;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`flex-1 flex flex-col items-center justify-center gap-1 transition-colors ${
        active ? "text-accent" : "text-muted"
      }`}
    >
      {children}
      <span className="text-2xs font-medium leading-none">{label}</span>
    </Link>
  );
}
