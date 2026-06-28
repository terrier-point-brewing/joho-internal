"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { NavEntry } from "@/app/taproom/nav-config";
import { useUserRole } from "@/lib/hooks/useUserRole";

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
  const { role } = useUserRole();
  const isAdmin = role === "admin";
  const visible = entries.filter((e) => !e.adminOnly || isAdmin);

  const cls = mobile
    ? "md:hidden flex border-b border-zinc-800 overflow-x-auto overflow-y-hidden scrollbar-none"
    : sticky
    ? "flex gap-1 border-b border-zinc-800 overflow-x-auto overflow-y-hidden scrollbar-none sticky top-11 md:static z-40 bg-zinc-950/95"
    : "flex gap-1 border-b border-zinc-800 overflow-x-auto overflow-y-hidden scrollbar-none";

  return (
    <div className={cls}>
      {visible.map(({ href, match, label, exact }) => {
        const active = pathname === href || (!exact && pathname.startsWith(match ?? href + "/"));
        return (
          <Link
            key={href}
            href={href}
            className={`px-4 py-2.5 text-sm font-medium whitespace-nowrap transition-colors border-b-2 -mb-px ${
              active
                ? "text-amber-400 border-amber-500"
                : "text-zinc-500 border-transparent hover:text-zinc-300"
            }`}
          >
            {label}
          </Link>
        );
      })}
    </div>
  );
}
