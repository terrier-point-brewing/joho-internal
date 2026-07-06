export type NavEntry = { href: string; match?: string; label: string; adminOnly?: boolean; managerOnly?: boolean; exact?: boolean };

export const TAPROOM_NAV: NavEntry[] = [
  { href: "/taproom/performance", label: "Performance" },
  { href: "/taproom/targets",     label: "Targets"     },
  { href: "/taproom/payroll",     label: "Payroll",     managerOnly: true },
  { href: "/taproom/settings",    label: "Settings",    managerOnly: true },
];

export const PERFORMANCE_NAV: NavEntry[] = [
  { href: "/taproom/performance/sales-pulse", label: "Sales Pulse" },
  { href: "/taproom/performance/draft-stats", label: "Draft Stats" },
  { href: "/taproom/performance/inventory",   label: "Inventory"   },
  { href: "/taproom/performance/events",      label: "Events"      },
];

export const TAPROOM_SETTINGS_NAV: NavEntry[] = [
  { href: "/taproom/settings/square-links", label: "Square Item Mappings" },
];

export const TARGETS_NAV: NavEntry[] = [
  { href: "/taproom/targets/achievement",    label: "Achievement"    },
  { href: "/taproom/targets/target-setting", label: "Target Setting" },
  { href: "/taproom/targets/manual-entries", label: "Manual Entries" },
];
