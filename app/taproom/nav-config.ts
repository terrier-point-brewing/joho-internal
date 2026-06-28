export type NavEntry = { href: string; match?: string; label: string; adminOnly?: boolean; managerOnly?: boolean; exact?: boolean };

export const TAPROOM_NAV: NavEntry[] = [
  { href: "/taproom/performance", label: "Performance" },
  { href: "/taproom/targets",     label: "Targets"     },
  { href: "/taproom/payroll",     label: "Payroll",     managerOnly: true },
  { href: "/taproom/reports",     label: "Reports",     adminOnly: true },
];

export const PERFORMANCE_NAV: NavEntry[] = [
  { href: "/taproom/performance/sales-pulse", label: "Sales Pulse" },
  { href: "/taproom/performance/draft-stats", label: "Draft Stats" },
  { href: "/taproom/performance/events",      label: "Events"      },
];

export const TARGETS_NAV: NavEntry[] = [
  { href: "/taproom/targets/achievement",    label: "Achievement"    },
  { href: "/taproom/targets/target-setting", label: "Target Setting" },
  { href: "/taproom/targets/manual-entries", label: "Manual Entries" },
];
