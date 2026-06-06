"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

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

export default function NavBar() {
  const pathname     = usePathname();
  const searchParams = useSearchParams();
  const activeTab    = searchParams.get("tab") ?? "";

  const isProduction = pathname === "/production" || pathname.startsWith("/production/");
  const isTaproom    = pathname === "/taproom"    || pathname.startsWith("/taproom/") ||
                       pathname === "/reports"    || pathname.startsWith("/reports/");

  const subtabCls = (active: boolean) =>
    `px-2 py-1.5 rounded text-xs font-medium transition-colors ${
      active
        ? "text-amber-400 bg-amber-900/20"
        : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/40"
    }`;

  return (
    <aside className="w-48 shrink-0 bg-zinc-900 border-r border-zinc-800 flex flex-col min-h-screen">
      {/* Logo */}
      <div className="px-4 py-5 border-b border-zinc-800">
        <span className="text-base font-bold text-zinc-100 tracking-wide">TPB</span>
      </div>

      <nav className="flex flex-col gap-0.5 p-2">
        {/* Taproom Management */}
        <Link
          href="/taproom?tab=targets"
          className={`px-3 py-2 rounded text-sm font-medium transition-colors ${
            isTaproom
              ? "bg-zinc-800 text-zinc-100"
              : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
          }`}
        >
          Taproom Management
        </Link>

        {isTaproom && (
          <div className="mt-1 ml-2 flex flex-col gap-0.5 border-l border-zinc-800 pl-2">
            {TAPROOM_TABS.map(({ key, label }) => (
              <Link
                key={key}
                href={`/taproom?tab=${key}`}
                className={subtabCls(activeTab === key || (key === "targets" && activeTab === ""))}
              >
                {label}
              </Link>
            ))}
          </div>
        )}

        {/* Production */}
        <Link
          href="/production?tab=intake"
          className={`px-3 py-2 rounded text-sm font-medium transition-colors ${
            isProduction
              ? "bg-zinc-800 text-zinc-100"
              : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
          }`}
        >
          Production
        </Link>

        {isProduction && (
          <div className="mt-1 ml-2 flex flex-col gap-0.5 border-l border-zinc-800 pl-2">
            {PRODUCTION_TABS.map(({ key, label }) => (
              <Link
                key={key}
                href={`/production?tab=${key}`}
                className={subtabCls(activeTab === key)}
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
