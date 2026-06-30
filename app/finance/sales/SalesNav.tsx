"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/finance/sales/taproom",          label: "Taproom"          },
  { href: "/finance/sales/events",           label: "Events"           },
  { href: "/finance/sales/contract-brewing", label: "Contract Brewing" },
  { href: "/finance/sales/distribution",     label: "Distribution"     },
  { href: "/finance/sales/wholesale",        label: "Wholesale"        },
];

export default function SalesNav() {
  const pathname = usePathname();
  return (
    <div className="flex items-center gap-1 pb-4 border-b border-zinc-800 overflow-x-auto">
      {TABS.map(({ href, label }) => {
        const active = pathname === href;
        return (
          <Link key={href} href={href}
            className={`px-3 py-1.5 text-xs font-medium border-b-2 -mb-px transition-colors ${
              active
                ? "text-amber-400 border-amber-500"
                : "text-zinc-500 border-transparent hover:text-zinc-300"
            }`}>
            {label}
          </Link>
        );
      })}
    </div>
  );
}
