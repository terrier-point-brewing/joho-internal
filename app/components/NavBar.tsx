"use client";

import Link from "next/link";
import { usePathname, useSearchParams, useRouter } from "next/navigation";
import { useState, useEffect } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { useUserRole } from "@/lib/hooks/useUserRole";

const TAPROOM_TABS = [
  { key: "performance", label: "Performance" },
  { key: "targets",     label: "Targets"     },
  { key: "reports",     label: "Reports"     },
] as const;

const PRODUCTION_TABS = [
  { key: "intake",    label: "Intake"    },
  { key: "brewing",   label: "Brewing"   },
  { key: "export",    label: "Export"    },
  { key: "recipes",   label: "Recipes"   },
  { key: "inventory", label: "Inventory" },
  { key: "partners",  label: "Partners"  },
] as const;

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
  const pathname     = usePathname();
  const searchParams = useSearchParams();
  const activeTab    = searchParams.get("tab") ?? "";
  const router       = useRouter();

  const { role, user, loading } = useUserRole();

  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem(STORAGE_KEY) === "true";
  });

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
  const isTaproom    = pathname === "/taproom"    || pathname.startsWith("/taproom/") ||
                       pathname === "/reports"    || pathname.startsWith("/reports/");
  const isFinance    = pathname === "/finance"    || pathname.startsWith("/finance/");
  const isSettings   = pathname.startsWith("/settings");

  // Derived permissions — only evaluated after loading is done.
  const isAdmin            = role === "admin";
  const canAccessProduction = role === "brewer" || role === "manager" || role === "admin";

  const subtabCls = (active: boolean) =>
    `px-2 py-1.5 rounded text-xs font-medium transition-colors ${
      active
        ? "text-amber-400 bg-amber-900/20"
        : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/40"
    }`;

  return (
    <>
      {/* ── Desktop sidebar ─────────────────────────────────────────────────── */}
      <aside
        className={`hidden md:flex shrink-0 bg-zinc-900 border-r border-zinc-800 flex-col h-screen sticky top-0 transition-all duration-200 ${
          collapsed ? "w-10" : "w-48"
        }`}
      >
        {/* Logo / toggle row */}
        <div className={`flex items-center border-b border-zinc-800 ${collapsed ? "justify-center px-0 py-5" : "px-4 py-5"}`}>
          {!collapsed && (
            <span className="text-base font-bold text-zinc-100 tracking-wide flex-1">TPB</span>
          )}
          <button
            onClick={() => setCollapsed((c) => !c)}
            className="text-zinc-500 hover:text-zinc-200 transition-colors p-1 rounded hover:bg-zinc-800/60"
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
              href="/taproom?tab=targets"
              className={`px-3 py-2 rounded text-sm font-medium transition-colors ${
                isTaproom ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
              }`}
            >
              Taproom Management
            </Link>
            {isTaproom && (
              <div className="mt-1 ml-2 flex flex-col gap-0.5 border-l border-zinc-800 pl-2">
                {TAPROOM_TABS.map(({ key, label }) => (
                  <Link key={key} href={`/taproom?tab=${key}`}
                    className={subtabCls(activeTab === key || (key === "targets" && activeTab === ""))}>
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
                      href="/production?tab=intake"
                      className={`px-3 py-2 rounded text-sm font-medium transition-colors ${
                        isProduction ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
                      }`}
                    >
                      Production
                    </Link>
                    {isProduction && (
                      <div className="mt-1 ml-2 flex flex-col gap-0.5 border-l border-zinc-800 pl-2">
                        {PRODUCTION_TABS.map(({ key, label }) => (
                          <Link key={key} href={`/production?tab=${key}`} className={subtabCls(activeTab === key)}>
                            {label}
                          </Link>
                        ))}
                      </div>
                    )}
                  </>
                )}

                {isAdmin && (
                  <>
                    <Link
                      href="/finance/model"
                      className={`px-3 py-2 rounded text-sm font-medium transition-colors mt-2 ${
                        isFinance ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
                      }`}
                    >
                      Finance
                    </Link>
                    {isFinance && (
                      <div className="mt-1 ml-2 flex flex-col gap-0.5 border-l border-zinc-800 pl-2">
                        {[
                          { key: "model",    label: "Model",    href: "/finance/model",        match: "/finance/model"    },
                          { key: "sales",    label: "Sales",    href: "/finance/sales/taproom", match: "/finance/sales"    },
                          { key: "invoices", label: "Invoices", href: "/finance/invoices",      match: "/finance/invoices" },
                          { key: "import",   label: "Import",   href: "/finance/import",        match: "/finance/import"   },
                        ].map(({ key, label, href, match }) => (
                          <Link key={key} href={href} className={subtabCls(pathname.startsWith(match))}>
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
                    isSettings ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
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
            <Link href="/taproom?tab=targets" title="Taproom Management"
              className={`w-7 h-7 flex items-center justify-center rounded transition-colors ${isTaproom ? "bg-zinc-800 text-amber-400" : "text-zinc-600 hover:text-zinc-300 hover:bg-zinc-800/50"}`}>
              <TaproomIcon />
            </Link>
            {!loading && canAccessProduction && (
              <Link href="/production?tab=intake" title="Production"
                className={`w-7 h-7 flex items-center justify-center rounded transition-colors ${isProduction ? "bg-zinc-800 text-amber-400" : "text-zinc-600 hover:text-zinc-300 hover:bg-zinc-800/50"}`}>
                <ProductionIcon />
              </Link>
            )}
            {!loading && isAdmin && (
              <Link href="/finance/model" title="Finance"
                className={`w-7 h-7 flex items-center justify-center rounded transition-colors ${isFinance ? "bg-zinc-800 text-amber-400" : "text-zinc-600 hover:text-zinc-300 hover:bg-zinc-800/50"}`}>
                <FinanceIcon />
              </Link>
            )}
            {!loading && (
              <Link href="/settings/account" title="Settings"
                className={`w-7 h-7 flex items-center justify-center rounded transition-colors ${isSettings ? "bg-zinc-800 text-amber-400" : "text-zinc-600 hover:text-zinc-300 hover:bg-zinc-800/50"}`}>
                <SettingsIcon />
              </Link>
            )}
          </nav>
        )}

        {/* Account info + logout */}
        <div className="mt-auto border-t border-zinc-800 p-2 flex flex-col gap-1">
          {!collapsed && !loading && user && (
            <div className="px-2 py-1.5">
              <div className="text-xs text-zinc-300 truncate">{user.email}</div>
              <div className="text-[10px] text-zinc-600 mt-0.5">
                {role ? ROLE_LABELS[role] ?? role : ""}
              </div>
            </div>
          )}
          {collapsed ? (
            <button onClick={handleLogout} title="Sign out"
              className="w-7 h-7 flex items-center justify-center rounded text-zinc-600 hover:text-red-400 hover:bg-zinc-800/50 transition-colors mx-auto">
              <LogoutIcon />
            </button>
          ) : (
            <button onClick={handleLogout}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs text-zinc-500 hover:text-red-400 hover:bg-zinc-800/40 transition-colors">
              <LogoutIcon />
              Sign out
            </button>
          )}
        </div>
      </aside>

      {/* ── Mobile top bar ───────────────────────────────────────────────────── */}
      <div className="md:hidden fixed top-0 inset-x-0 z-50 bg-zinc-900 border-b border-zinc-800 flex items-center justify-between px-4 h-11">
        <span className="text-sm font-bold text-zinc-100 tracking-wide">TPB</span>
        {!loading && user && (
          <div className="text-right">
            <div className="text-xs text-zinc-300 truncate max-w-[200px]">{user.email}</div>
            <div className="text-[10px] text-zinc-600">{role ? ROLE_LABELS[role] ?? role : ""}</div>
          </div>
        )}
      </div>

      {/* ── Mobile bottom nav ────────────────────────────────────────────────── */}
      <nav className="md:hidden fixed bottom-0 inset-x-0 z-50 bg-zinc-900 border-t border-zinc-800 flex items-stretch">
        <MobileNavItem href="/taproom?tab=targets" active={isTaproom} label="Taproom">
          <TaproomIcon />
        </MobileNavItem>
        {!loading && canAccessProduction && (
          <MobileNavItem href="/production?tab=intake" active={isProduction} label="Production">
            <ProductionIcon />
          </MobileNavItem>
        )}
        {!loading && isAdmin && (
          <MobileNavItem href="/finance/model" active={isFinance} label="Finance">
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
          className="flex-1 flex flex-col items-center justify-center gap-1 py-2 text-zinc-500 hover:text-red-400 transition-colors"
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
        active ? "text-amber-400" : "text-zinc-500"
      }`}
    >
      {children}
      <span className="text-[10px] font-medium leading-none">{label}</span>
    </Link>
  );
}
