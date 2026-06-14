"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const SUBTABS = [
  { href: "/finance/statements/pl",            label: "P&L"           },
  { href: "/finance/statements/balance-sheet", label: "Balance Sheet" },
];

export default function StatementsNav() {
  const pathname = usePathname();
  return (
    <div className="flex gap-1 border-b border-zinc-800 px-4 sm:px-6">
      {SUBTABS.map(({ href, label }) => {
        const active = pathname.startsWith(href);
        return (
          <Link key={href} href={href}
            className={`px-3 py-2 text-xs font-medium border-b-2 -mb-px transition-colors whitespace-nowrap ${
              active
                ? "text-zinc-100 border-amber-500"
                : "text-zinc-500 border-transparent hover:text-zinc-300"
            }`}>
            {label}
          </Link>
        );
      })}
    </div>
  );
}
