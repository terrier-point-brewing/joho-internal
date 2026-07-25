// Scope assignment rules — ordered, first match wins (most specific first).
const RULES = [
  [/^admin\/cron-runs/,                    "settings.cron"],
  [/^admin\/(users|requests)/,             "settings.users"],
  [/^settings\/timezone/,                  "settings.business"],

  [/^brand\/(canon|chrome)/,               "brand.guide"],
  [/^brand\/(assets|labels)/,              "brand.workbench"],

  [/^finance\/(financials|pl|cogs|taxes)/, "finance.statements"],
  [/^finance\/payroll-periods/,            "payroll"],
  [/^finance\/settings\/payroll-department-mappings/, "payroll"],
  [/^finance\//,                           "finance.transactions"],
  [/^payroll\//,                           "payroll"],

  [/^(manual-entries|targets)/,            "taproom.targets"],
  [/^taproom\/(events|tap-swaps)/,         "taproom.performance"],
  [/^production\/taproom-consumption\/sync/, "production.brewing"],
  [/^production\/taproom-consumption/,     "taproom.performance"],

  [/^production\/(equipment|floorplan-settings)/,          "production.equipment"],
  [/^production\/(deposit-settings|export-settings)/,      "production.settings"],
  [/^production\/recipe-square-link/,                      "production.settings"],
  [/^production\/recipe/,                                  "production.recipes"],
  [/^production\/packaging-variations/,                    "production.recipes"],
  [/^production\/(ingredients|packaging|stock-adjustments|safety-stock)/, "production.inventory"],
  [/^production\/(allocations|exports?|deposit-invoices)/, "production.export"],
  [/^production\/contract-requests/,                       "production.partners"],
  [/^production\/(batch|brew-activities|tank-assignments|transfers)/, "production.brewing"],
  [/^partners\//,                                          "production.partners"],

  [/^tax\/.*\/reveal/,                     "tax.pii"],
  [/^tax\//,                               "tax"],
];

export function scopeFor(route) {
  const p = route.replace(/^app\/api\//, "").replace(/\/route\.ts$/, "");
  for (const [re, scope] of RULES) if (re.test(p)) return scope;
  return null;
}
