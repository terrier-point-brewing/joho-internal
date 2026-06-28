"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function PayrollNav() {
  const pathname = usePathname();
  const active = !pathname.startsWith("/finance/payroll/");

  return (
    <nav className="flex gap-1 mb-6">
      <Link
        href="/finance/payroll"
        className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
          active
            ? "text-amber-400 bg-amber-900/20"
            : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/40"
        }`}
      >
        Periods
      </Link>
    </nav>
  );
}
