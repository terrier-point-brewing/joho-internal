import type { Capability } from "@/lib/auth/capabilities";
import { CAP } from "@/lib/auth/capabilities";

export type NavEntry = { href: string; match?: string; label: string; requires?: Capability; exact?: boolean };

export const TAPROOM_NAV: NavEntry[] = [
  { href: "/taproom/performance", label: "Performance" },
  { href: "/taproom/targets",     label: "Targets"     },
  { href: "/taproom/payroll",     label: "Payroll",     requires: CAP.payrollRead },
  // No Settings entry: taproom.settings retired with zero screens of its own.
  // Its only screen was Square Item Mappings, which is `catalog` — one scope
  // for a capability reachable from more than one section.
];

export const PERFORMANCE_NAV: NavEntry[] = [
  { href: "/taproom/performance/sales-pulse", label: "Sales Pulse" },
  { href: "/taproom/performance/draft-stats", label: "Draft Stats" },
  { href: "/taproom/performance/inventory",   label: "Inventory"   },
  { href: "/taproom/performance/events",      label: "Events"      },
];

export const TARGETS_NAV: NavEntry[] = [
  { href: "/taproom/targets/achievement",    label: "Achievement"    },
  { href: "/taproom/targets/target-setting", label: "Target Setting" },
];
