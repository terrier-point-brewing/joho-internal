"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/finance/pl",       label: "P&L"      },
  { href: "/finance/expenses", label: "Expenses" },
  { href: "/finance/cogs",     label: "COGS"     },
  { href: "/finance/taxes",    label: "Taxes"    },
];

export default function FinanceNav() {
  const pathname = usePathname();
  return (
    <div className="flex items-center gap-1 border-b border-zinc-800 px-6 pt-4 pb-0">
      {TABS.map(({ href, label }) => {
        const active = pathname === href || pathname.startsWith(href + "/");
        return (
          <Link
            key={href}
            href={href}
            className={`px-4 py-2 text-sm font-medium rounded-t transition-colors border-b-2 -mb-px ${
              active
                ? "text-amber-400 border-amber-400 bg-zinc-800/30"
                : "text-zinc-500 border-transparent hover:text-zinc-300 hover:border-zinc-600"
            }`}
          >
            {label}
          </Link>
        );
      })}
    </div>
  );
}
