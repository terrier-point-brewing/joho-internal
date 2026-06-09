"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export default function SettingsTabs({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname();

  const tabs = [
    { label: "Account", href: "/settings/account" },
    ...(isAdmin ? [{ label: "Users", href: "/settings/users" }] : []),
  ];

  return (
    <div className="border-b border-zinc-800 px-6 pt-6">
      <h1 className="text-lg font-semibold text-zinc-100 mb-4">Settings</h1>
      <div className="flex gap-1">
        {tabs.map(({ label, href }) => (
          <Link
            key={href}
            href={href}
            className={`px-4 py-2 text-sm font-medium rounded-t transition-colors ${
              pathname === href || pathname.startsWith(href + "/")
                ? "text-zinc-100 bg-zinc-800"
                : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {label}
          </Link>
        ))}
      </div>
    </div>
  );
}
