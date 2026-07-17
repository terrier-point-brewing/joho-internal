"use client";

import Link from "next/link";

/** Plain text "back to list" link for detail/subroute pages. */
export default function BackLink({ href, label = "Back" }: { href: string; label?: string }) {
  return (
    <Link href={href} className="inline-flex items-center gap-1 text-xs text-muted hover:text-body transition-colors">
      ← {label}
    </Link>
  );
}
