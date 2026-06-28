"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const PAYROLL_NAV = [
  { href: "/finance/payroll",          label: "Periods"  },
  { href: "/finance/payroll/settings", label: "Settings" },
];

export function PayrollNav() {
  const pathname = usePathname();
  const isSettings = pathname.startsWith("/finance/payroll/settings");

  return (
    <nav className="flex gap-1 mb-6">
      {PAYROLL_NAV.map(({ href, label }) => {
        const active =
          href === "/finance/payroll" ? !isSettings : isSettings;
        return (
          <Link
            key={href}
            href={href}
            className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
              active
                ? "text-amber-400 bg-amber-900/20"
                : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/40"
            }`}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
