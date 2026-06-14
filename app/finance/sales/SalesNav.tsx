"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/finance/sales/taproom",          label: "Taproom"          },
  { href: "/finance/sales/events",           label: "Events"           },
  { href: "/finance/sales/contract-brewing", label: "Contract Brewing" },
  { href: "/finance/sales/distribution",     label: "Distribution"     },
];

export default function SalesNav() {
  const pathname = usePathname();
  return (
    <div className="flex items-center gap-1 pb-4 border-b border-zinc-800 overflow-x-auto">
      {TABS.map(({ href, label }) => {
        const active = pathname === href;
        return (
          <Link key={href} href={href}
            className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
              active
                ? "bg-zinc-800 text-zinc-100"
                : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50"
            }`}>
            {label}
          </Link>
        );
      })}
    </div>
  );
}
