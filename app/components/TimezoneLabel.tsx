"use client";

import { useBreweryTimezone } from "@/app/hooks/useBreweryTimezone";

// Compact, read-only indicator of the zone all dates on a reporting surface are
// calculated in — so a viewer in another timezone is never left guessing which
// "day" a number belongs to. Change the zone in Settings → Business.
export default function TimezoneLabel({ className = "" }: { className?: string }) {
  const { label, timezone } = useBreweryTimezone();
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs text-muted ${className}`}
      title={`All dates are calculated in the taproom's timezone (${timezone}). Change it in Settings → Business.`}
    >
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      Times in {label}
    </span>
  );
}
