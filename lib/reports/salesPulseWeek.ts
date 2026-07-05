// Week view-model for the taproom Sales Pulse tab.
//
// The Sales Pulse chart and day filter render a Mon–Sun grid and map the API's
// per-day buckets onto it by index. Those buckets are computed server-side in
// the brewery timezone, so the grid must be derived in the *same* zone — if the
// week boundaries are computed in the viewer's browser zone instead, an
// off-by-one shift attributes a day's sales to the neighbouring column (e.g. a
// Saturday sale surfacing under Sunday). Every date here is a brewery-local
// YYYY-MM-DD string produced by the tz-pinned helpers in lib/utils/datetime, so
// the model is pure and zone-independent given brewery-local inputs.

import { addDaysStr, mondayOf } from "@/lib/utils/datetime";

// Monday-first weekday labels, aligned index-for-index with the API's `daily[]`
// array (which starts at the week's Monday).
export const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

export interface DayPill {
  label: string; // "Mon" .. "Sun"
  index: number; // 0=Mon .. 6=Sun
  dateStr: string; // YYYY-MM-DD, brewery-local
  isFuture: boolean; // day has not started yet at the brewery
}

export interface SalesWeekView {
  curStart: string; // the displayed week's Monday
  curEnd: string; // that week's Sunday
  priorStart: string; // prior-week comparator Monday
  priorEnd: string; // prior-week comparator Sunday
  effectiveEnd: string; // curEnd, clamped to today so we never query the future
  isCurrentWeek: boolean; // the displayed week contains today
  label: string; // "Jun 29 – Jul 5"
  dayPills: DayPill[]; // one per weekday, Mon-first
}

// Format a YYYY-MM-DD as "Jun 29", anchored at UTC noon so the runtime zone can
// never shift the rendered day.
function shortDate(dateStr: string): string {
  return new Date(`${dateStr}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

// "Jun 29 – Jul 5" for the Mon–Sun week starting at `monday`.
export function weekLabel(monday: string): string {
  return `${shortDate(monday)} – ${shortDate(addDaysStr(monday, 6))}`;
}

// Build the Mon–Sun view model. Both `weekStart` (the displayed Monday) and
// `todayStr` must be brewery-local YYYY-MM-DD strings — resolve them with
// mondayOf() and todayLocalDate() against the active brewery zone, never with
// the browser's local Date.
export function buildSalesWeekView(weekStart: string, todayStr: string): SalesWeekView {
  const curEnd = addDaysStr(weekStart, 6);
  const dayPills: DayPill[] = DAY_LABELS.map((label, index) => {
    const dateStr = addDaysStr(weekStart, index);
    return { label, index, dateStr, isFuture: dateStr > todayStr };
  });

  return {
    curStart: weekStart,
    curEnd,
    priorStart: addDaysStr(weekStart, -7),
    priorEnd: addDaysStr(weekStart, -1),
    effectiveEnd: curEnd < todayStr ? curEnd : todayStr,
    isCurrentWeek: weekStart === mondayOf(todayStr),
    label: weekLabel(weekStart),
    dayPills,
  };
}
