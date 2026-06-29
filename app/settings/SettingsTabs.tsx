"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

export default function SettingsTabs({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname();
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    if (!isAdmin) return;
    fetch("/api/admin/requests")
      .then((r) => r.ok ? r.json() : [])
      .then((data: { status: string }[]) =>
        setPendingCount(data.filter((r) => r.status === "pending").length)
      )
      .catch(() => {});
  }, [isAdmin]);

  const tabs = [
    { label: "Account", href: "/settings/account", badge: 0 },
    ...(isAdmin ? [
      { label: "Users", href: "/settings/users", badge: 0 },
      { label: "Access Requests", href: "/settings/requests", badge: pendingCount },
    ] : []),
  ];

  return (
    <div className="px-4 sm:px-6 pt-4 sm:pt-6">
      <h1 className="text-base font-semibold text-zinc-100 mb-4">Settings</h1>
      <div
        className="flex gap-1 border-b border-zinc-800 overflow-x-auto overflow-y-hidden scrollbar-none"
        role="tablist"
      >
        {tabs.map(({ label, href, badge }) => {
          const active = pathname === href || pathname.startsWith(href + "/");
          return (
            <Link
              key={href}
              href={href}
              role="tab"
              aria-selected={active}
              className={`px-4 py-2.5 text-sm font-medium whitespace-nowrap transition-colors border-b-2 -mb-px flex items-center gap-1.5 ${
                active
                  ? "text-amber-400 border-amber-500"
                  : "text-zinc-500 border-transparent hover:text-zinc-300"
              }`}
            >
              {label}
              {badge > 0 && (
                <span className="text-xs bg-amber-500 text-zinc-950 font-bold rounded-full px-1.5 py-0.5 leading-none">
                  {badge}
                </span>
              )}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
