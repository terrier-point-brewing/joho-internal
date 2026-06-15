"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { FINANCE_NAV } from "./nav-config";

export default function FinanceNav({ mobile = false }: { mobile?: boolean }) {
  const pathname = usePathname();

  if (mobile) {
    return (
      <div className="md:hidden flex border-b border-zinc-800 overflow-x-auto scrollbar-none">
        {FINANCE_NAV.map(({ href, label, match, also }) => {
          const active = pathname === href || pathname.startsWith(match ?? href) || (!!also && pathname.startsWith(also));
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
      {FINANCE_NAV.map(({ href, label, match, also }) => {
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
