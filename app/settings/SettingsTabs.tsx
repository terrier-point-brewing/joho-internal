"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import PageHeader from "@/app/components/PageHeader";
import { TAB_ROW, tabItem } from "@/app/components/ui/tabStyles";
import { usePermissions } from "@/lib/hooks/useUserRole";
import { CAP } from "@/lib/auth";
import type { Capability } from "@/lib/auth";

export default function SettingsTabs() {
  const pathname = usePathname();
  const { can } = usePermissions();
  const canManageUsers = can(CAP.usersManage);
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    if (!canManageUsers) return;
    fetch("/api/admin/requests")
      .then((r) => r.ok ? r.json() : [])
      .then((data: { status: string }[]) =>
        setPendingCount(data.filter((r) => r.status === "pending").length)
      )
      .catch(() => {});
  }, [canManageUsers]);

  const allTabs: { label: string; href: string; badge: number; requires?: Capability }[] = [
    { label: "Account", href: "/settings/account", badge: 0 },
    { label: "Appearance", href: "/settings/appearance", badge: 0 },
    { label: "Business", href: "/settings/business", badge: 0, requires: CAP.businessSettingsManage },
    { label: "Users", href: "/settings/users", badge: 0, requires: CAP.usersManage },
    { label: "Access Requests", href: "/settings/requests", badge: pendingCount, requires: CAP.usersManage },
    { label: "Cron Jobs", href: "/settings/cron", badge: 0, requires: CAP.cronRead },
  ];
  const tabs = allTabs.filter((t) => !t.requires || can(t.requires));

  return (
    <div className="px-4 sm:px-6">
      <PageHeader title="Settings" />
      <div className={TAB_ROW} role="tablist">
        {tabs.map(({ label, href, badge }) => {
          const active = pathname === href || pathname.startsWith(href + "/");
          return (
            <Link
              key={href}
              href={href}
              role="tab"
              aria-selected={active}
              className={`${tabItem(active)} flex items-center gap-1.5`}
            >
              {label}
              {badge > 0 && (
                <span className="text-xs bg-accent-emphasis text-canvas font-bold rounded-full px-1.5 py-0.5 leading-none">
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
