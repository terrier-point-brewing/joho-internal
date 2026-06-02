"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

const PRODUCTION_TABS = [
  { key: "brew-console",  label: "Brew Console"  },
  { key: "brew-planner",  label: "Brew Planner"  },
  { key: "workflows",     label: "Workflows"      },
  { key: "recipes",       label: "Recipes"        },
  { key: "inventory",     label: "Inventory"      },
  { key: "partners",      label: "Partners"       },
] as const;

export default function NavBar() {
  const pathname     = usePathname();
  const searchParams = useSearchParams();
  const activeTab    = searchParams.get("tab") ?? "brew-console";

  const isProduction = pathname === "/production" || pathname.startsWith("/production/");
  const isReports    = pathname === "/reports"    || pathname.startsWith("/reports/");

  return (
    <aside className="w-48 shrink-0 bg-zinc-900 border-r border-zinc-800 flex flex-col min-h-screen">
      {/* Logo */}
      <div className="px-4 py-5 border-b border-zinc-800">
        <span className="text-base font-bold text-zinc-100 tracking-wide">TPB</span>
      </div>

      {/* Top-level modules */}
      <nav className="flex flex-col gap-0.5 p-2">
        <Link
          href="/reports"
          className={`px-3 py-2 rounded text-sm font-medium transition-colors ${
            isReports
              ? "bg-zinc-800 text-zinc-100"
              : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
          }`}
        >
          Reports
        </Link>

        {/* Production — always show, subtabs expand below */}
        <Link
          href="/production?tab=brew-console"
          className={`px-3 py-2 rounded text-sm font-medium transition-colors ${
            isProduction
              ? "bg-zinc-800 text-zinc-100"
              : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
          }`}
        >
          Production
        </Link>

        {/* Production subtabs */}
        {isProduction && (
          <div className="mt-1 ml-2 flex flex-col gap-0.5 border-l border-zinc-800 pl-2">
            {PRODUCTION_TABS.map(({ key, label }) => (
              <Link
                key={key}
                href={`/production?tab=${key}`}
                className={`px-2 py-1.5 rounded text-xs font-medium transition-colors ${
                  activeTab === key
                    ? "text-amber-400 bg-amber-900/20"
                    : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/40"
                }`}
              >
                {label}
              </Link>
            ))}
          </div>
        )}
      </nav>
    </aside>
  );
}
