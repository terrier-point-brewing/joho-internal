export type NavEntry = { href: string; match?: string; label: string; adminOnly?: boolean; exact?: boolean };

export const PRODUCTION_NAV: NavEntry[] = [
  { href: "/production/intake",    label: "Intake"    },
  { href: "/production/brewing",   label: "Brewing"   },
  { href: "/production/export",    label: "Export"    },
  { href: "/production/recipes",   label: "Recipes"   },
  { href: "/production/inventory", label: "Inventory" },
  { href: "/production/partners",  label: "Partners"  },
  { href: "/production/settings",  label: "Settings"  },
];

export const BREWING_NAV: NavEntry[] = [
  { href: "/production/brewing/floorplan", label: "Floorplan" },
  { href: "/production/brewing/batch-log", label: "Batch Log" },
  { href: "/production/brewing/timeline",  label: "Timeline"  },
  { href: "/production/brewing/transfers", label: "Transfers" },
  { href: "/production/brewing/calendar",  label: "Calendar",  adminOnly: true },
];

export const RECIPES_NAV: NavEntry[] = [
  { href: "/production/recipes",                     label: "Brewing Recipes",    exact: true },
  { href: "/production/recipes/variations",          label: "Packaging Variations" },
  { href: "/production/recipes/brew-step-templates", label: "Brew Step Templates" },
];

export const SETTINGS_NAV: NavEntry[] = [
  { href: "/production/settings/deposits",     label: "Deposit Settings" },
  { href: "/production/settings/export",       label: "Export Settings"  },
  { href: "/production/settings/square-links", label: "Square Mappings"  },
];
