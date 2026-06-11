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
    <div className="border-b border-zinc-800 px-4 sm:px-6 pt-4 sm:pt-6">
      <h1 className="text-lg font-semibold text-zinc-100 mb-4">Settings</h1>
      <div className="flex flex-wrap gap-1">
        {tabs.map(({ label, href, badge }) => (
          <Link
            key={href}
            href={href}
            className={`px-4 py-2 text-sm font-medium rounded-t transition-colors flex items-center gap-1.5 ${
              pathname === href || pathname.startsWith(href + "/")
                ? "text-zinc-100 bg-zinc-800"
                : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {label}
            {badge > 0 && (
              <span className="text-xs bg-amber-500 text-zinc-950 font-bold rounded-full px-1.5 py-0.5 leading-none">
                {badge}
              </span>
            )}
          </Link>
        ))}
      </div>
    </div>
  );
}
