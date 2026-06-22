"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const SUBTABS = [
  { href: "/finance/settings/chart-of-accounts", label: "Chart of Accounts" },
  { href: "/finance/settings/account-mapping",   label: "Account Mapping"   },
  { href: "/finance/settings/excise-tax",        label: "Excise Tax"       },
  { href: "/finance/settings/import",            label: "Import"            },
];

export default function SettingsNav() {
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
