"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { useUserRole, usePermissions } from "@/lib/hooks/useUserRole";
import { CAP } from "@/lib/auth";
import { FINANCE_NAV } from "@/app/finance/nav-config";
import { TAPROOM_NAV } from "@/app/taproom/nav-config";
import { PRODUCTION_NAV } from "@/app/production/nav-config";
import { BRAND_TABS } from "@/app/brand/nav-config";

const ROLE_LABELS: Record<string, string> = {
  viewer: "Viewer", brewer: "Brewer", manager: "Manager", admin: "Admin",
};

const STORAGE_KEY = "tpb-sidebar-collapsed";

// ── Icons ──────────────────────────────────────────────────────────────────────

const TaproomIcon = () => (
  <svg width="20" height="20" viewBox="0 0 14 14" fill="none">
    <rect x="1" y="3" width="12" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.4"/>
    <path d="M4 3V2.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1V3" stroke="currentColor" strokeWidth="1.4"/>
  </svg>
);
const ProductionIcon = () => (
  <svg width="20" height="20" viewBox="0 0 14 14" fill="none">
    <path d="M2 11V6l3-3h4l3 3v5H2z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/>
    <path d="M5 11V8h4v3" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/>
  </svg>
);
const FinanceIcon = () => (
  <svg width="20" height="20" viewBox="0 0 14 14" fill="none">
    <rect x="1" y="4" width="12" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.4"/>
    <path d="M4 4V3a2 2 0 014 0v1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
    <path d="M7 7.5v1M5.5 8.5h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
  </svg>
);
const BrandIcon = () => (
  <svg width="20" height="20" viewBox="0 0 14 14" fill="none">
    <path d="M7 1.5l1.7 3.4 3.8.55-2.75 2.68.65 3.77L7 10.13 3.85 11.9l.65-3.77L1.75 5.45l3.8-.55L7 1.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
  </svg>
);
const SettingsIcon = () => (
  <svg width="20" height="20" viewBox="0 0 14 14" fill="none">
    <circle cx="7" cy="7" r="2" stroke="currentColor" strokeWidth="1.3"/>
    <path d="M7 1v1.5M7 11.5V13M1 7h1.5M11.5 7H13M2.93 2.93l1.06 1.06M10.01 10.01l1.06 1.06M2.93 11.07l1.06-1.06M10.01 3.99l1.06-1.06" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
  </svg>
);
const LogoutIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
    <path d="M9 10l3-3-3-3M12 7H5M5 2H2.5A1.5 1.5 0 001 3.5v7A1.5 1.5 0 002.5 12H5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

// ── Component ──────────────────────────────────────────────────────────────────

export default function NavBar() {
  const pathname = usePathname();

  const { role, user, loading } = useUserRole();
  const { can } = usePermissions();

  const [collapsed, setCollapsed] = useState(false);

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

  const isProduction = pathname === "/production" || pathname.startsWith("/production/");
  const isTaproom    = pathname === "/taproom" || pathname.startsWith("/taproom/");
  const isFinance    = pathname === "/finance"    || pathname.startsWith("/finance/");
  const isBrand      = pathname === "/brand"      || pathname.startsWith("/brand/");
  const isSettings   = pathname.startsWith("/settings");

  // Derived permissions — only evaluated after loading is done. Reuses the
  // same capabilities their respective layouts gate on, so NavBar visibility
  // and the server-side redirect can never drift apart.
  const canAccessProduction = can(CAP.productionSettingsRead);
  const canAccessBrand      = can(CAP.brandGuideRead);
  const canAccessFinance    = can(CAP.financeStatementsRead);

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
          {!collapsed && (
            <span className="text-base font-bold text-primary tracking-wide flex-1">TPB</span>
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

                {canAccessFinance && (
                  <>
                    <Link
                      href="/finance/financials"
                      className={`px-3 py-2 rounded text-sm font-medium transition-colors mt-2 ${
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
                  href="/settings/account"
                  className={`px-3 py-2 rounded text-sm font-medium transition-colors mt-1 ${
                    isSettings ? "bg-surface-mid text-primary" : "text-secondary hover:text-strong hover:bg-surface-mid/50"
                  }`}
                >
                  Settings
                </Link>
              </>
            )}
          </nav>
        )}

        {/* Collapsed: icon-only nav */}
        {collapsed && (
          <nav className="flex flex-col items-center gap-1 p-1 pt-2">
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
            {!loading && canAccessFinance && (
              <Link href="/finance/financials" title="Finance"
                className={`w-7 h-7 flex items-center justify-center rounded transition-colors ${isFinance ? "bg-surface-mid text-accent" : "text-faint hover:text-body hover:bg-surface-mid/50"}`}>
                <FinanceIcon />
              </Link>
            )}
            {!loading && (
              <Link href="/settings/account" title="Settings"
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
      <div className="md:hidden fixed top-0 inset-x-0 z-50 bg-surface border-b border-line flex items-center justify-between px-4 h-11">
        <span className="text-sm font-bold text-primary tracking-wide">TPB</span>
        {!loading && user && (
          <div className="text-right">
            <div className="text-xs text-body truncate max-w-[200px]">{user.email}</div>
            <div className="text-[10px] text-faint">{role ? ROLE_LABELS[role] ?? role : ""}</div>
          </div>
        )}
      </div>

      {/* ── Mobile bottom nav ────────────────────────────────────────────────── */}
      <nav className="md:hidden fixed bottom-0 inset-x-0 z-50 bg-surface border-t border-line flex items-stretch">
        <MobileNavItem href="/taproom/performance" active={isTaproom} label="Taproom">
          <TaproomIcon />
        </MobileNavItem>
        {!loading && canAccessProduction && (
          <MobileNavItem href="/production/intake" active={isProduction} label="Production">
            <ProductionIcon />
          </MobileNavItem>
        )}
        {!loading && canAccessBrand && (
          <MobileNavItem href="/brand/guide" active={isBrand} label="Brand">
            <BrandIcon />
          </MobileNavItem>
        )}
        {!loading && canAccessFinance && (
          <MobileNavItem href="/finance/financials" active={isFinance} label="Finance">
            <FinanceIcon />
          </MobileNavItem>
        )}
        {!loading && (
          <MobileNavItem href="/settings/account" active={isSettings} label="Settings">
            <SettingsIcon />
          </MobileNavItem>
        )}
        <button
          onClick={handleLogout}
          className="flex-1 flex flex-col items-center justify-center gap-1 py-2 text-muted hover:text-danger transition-colors"
        >
          <LogoutIcon />
          <span className="text-[10px] font-medium leading-none">Sign out</span>
        </button>
      </nav>
    </>
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
      className={`flex-1 flex flex-col items-center justify-center gap-1 py-2 transition-colors ${
        active ? "text-accent" : "text-muted"
      }`}
    >
      {children}
      <span className="text-[10px] font-medium leading-none">{label}</span>
    </Link>
  );
}
