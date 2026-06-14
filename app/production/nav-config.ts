export type NavEntry = { href: string; match?: string; label: string };

export const PRODUCTION_NAV: NavEntry[] = [
  { href: "/production/intake",    label: "Intake"    },
  { href: "/production/brewing",   label: "Brewing"   },
  { href: "/production/export",    label: "Export"    },
  { href: "/production/recipes",   label: "Recipes"   },
  { href: "/production/inventory", label: "Inventory" },
  { href: "/production/partners",  label: "Partners"  },
];

export const BREWING_NAV: NavEntry[] = [
  { href: "/production/brewing/floorplan", label: "Floorplan" },
  { href: "/production/brewing/batch-log", label: "Batch Log" },
  { href: "/production/brewing/timeline",  label: "Timeline"  },
  { href: "/production/brewing/calendar",  label: "Calendar"  },
];

export const RECIPES_NAV: NavEntry[] = [
  { href: "/production/recipes",                     label: "Recipes"             },
  { href: "/production/recipes/brew-step-templates", label: "Brew Step Templates" },
];
