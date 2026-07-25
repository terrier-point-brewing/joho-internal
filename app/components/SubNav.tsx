"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { usePermissions } from "@/lib/hooks/useUserRole";
import type { Capability } from "@/lib/auth";
import { TAB_ROW, tabItem } from "./ui/tabStyles";

export interface NavEntry {
  href: string;
  match?: string;
  also?: string;
  label: React.ReactNode;
  requires?: Capability;
  exact?: boolean;
}

export default function SubNav({
  entries,
  mobile = false,
  sticky = false,
}: {
  entries: NavEntry[];
  mobile?: boolean;
  sticky?: boolean;
}) {
  const pathname = usePathname();
  const { can } = usePermissions();
  const visible = entries.filter((e) => !e.requires || can(e.requires));

  const cls = mobile
    ? `md:hidden ${TAB_ROW}`
    : sticky
    ? `${TAB_ROW} sticky top-11 md:static z-40 bg-canvas/95`
    : TAB_ROW;

  return (
    <div className={cls}>
      {visible.map(({ href, match, also, label, exact }) => {
        const active =
          pathname === href ||
          (!exact && pathname.startsWith(match ?? href + "/")) ||
          (also != null && pathname.startsWith(also));
        return (
          <Link key={href} href={href} className={tabItem(active)}>
            {label}
          </Link>
        );
      })}
    </div>
  );
}
