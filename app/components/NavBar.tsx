"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const MODULES = [
  { href: "/reports",    label: "Reports"    },
  { href: "/production", label: "Production" },
] as const;

export default function NavBar() {
  const pathname = usePathname();

  return (
    <header className="bg-zinc-900 border-b border-zinc-700 px-6 py-0 flex items-stretch gap-0">
      <span className="py-4 pr-6 text-lg font-bold text-zinc-100 border-r border-zinc-700 mr-2 shrink-0">
        TPB
      </span>
      <nav className="flex items-stretch gap-1">
        {MODULES.map(({ href, label }) => {
          const active = pathname === href || pathname.startsWith(href + "/");
          return (
            <Link
              key={href}
              href={href}
              className={`
                px-4 py-4 text-sm font-medium border-b-2 transition-colors
                ${active
                  ? "border-blue-500 text-blue-400"
                  : "border-transparent text-zinc-400 hover:text-zinc-200 hover:border-zinc-500"}
              `}
            >
              {label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
