"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/finance/model",    label: "Model"    },
  { href: "/finance/sales/taproom", label: "Sales", match: "/finance/sales" },
  { href: "/finance/invoices", label: "Invoices" },
  { href: "/finance/import",   label: "Import"   },
];

export default function FinanceNav({ mobile = false }: { mobile?: boolean }) {
  const pathname = usePathname();

  if (mobile) {
    return (
      <div className="md:hidden flex border-b border-zinc-800 overflow-x-auto scrollbar-none">
        {TABS.map(({ href, label, match }) => {
          const active = pathname === href || pathname.startsWith(match ?? href);
          return (
            <Link key={href} href={href}
              className={`px-4 py-2.5 text-sm font-medium whitespace-nowrap transition-colors border-b-2 -mb-px ${
                active
                  ? "text-amber-400 border-amber-500"
                  : "text-zinc-500 border-transparent"
              }`}>
              {label}
            </Link>
          );
        })}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1">
      {TABS.map(({ href, label, match }) => {
        const active = pathname === href || pathname.startsWith(match ?? href);
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
