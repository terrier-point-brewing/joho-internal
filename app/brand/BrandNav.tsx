"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { TAB_ROW, tabItem } from "@/app/components/ui/tabStyles";
import { BRAND_TABS } from "./nav-config";

// isAdmin comes from the server layout (getSessionUser), not a client-side
// role fetch, so admin-only tabs never flash in for non-admins.
export default function BrandNav({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname();
  const visible = BRAND_TABS.filter((tab) => !tab.adminOnly || isAdmin);

  return (
    <div className={TAB_ROW}>
      {visible.map(({ href, label }) => (
        <Link key={href} href={href} className={tabItem(pathname === href)}>
          {label}
        </Link>
      ))}
    </div>
  );
}
