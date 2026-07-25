import { readFileSync } from "fs";
import { scopeFor } from "./scopes.js";

const RANK = { read: 1, operate: 2, manage: 3, admin: 4 };
const ROOT = "";

const BUNDLES = {
  viewer: { "taproom.performance": "read", "taproom.targets": "read" },
  brewer: {
    "taproom.performance": "read", "taproom.targets": "read",
    "production.brewing": "operate", "production.inventory": "operate",
    "production.export": "operate", "production.recipes": "operate",
    "production.partners": "operate", "production.settings": "manage",
    "production.equipment": "read",
  },
  manager: {
    taproom: "operate", "taproom.targets": "read",
    payroll: "operate", tax: "operate",
    "finance.transactions": "operate",
    "production.export": "read", "production.partners": "read",
    "production.settings": "operate",
  },
  admin: { [ROOT]: "admin" },
  custom: {},
};

// longest-prefix wins; ROOT ("") matches everything
function effectiveLevel(grants, scope) {
  let best = null, bestLen = -1;
  for (const [key, lvl] of Object.entries(grants)) {
    const matches = key === ROOT || scope === key || scope.startsWith(key + ".");
    if (matches && key.length > bestLen) { best = lvl; bestLen = key.length; }
  }
  return best;
}
const can = (grants, scope, need) => {
  const lvl = effectiveLevel(grants, scope);
  return lvl != null && RANK[lvl] >= RANK[need];
};

// ── level assignment: (scope, legacyKey) -> level, with per-route overrides ──
const GROUP_LEVEL = {
  "brand.guide|":                    "manage",
  "brand.workbench|":                (m) => (m === "GET" ? "read" : "manage"),
  "finance.statements|":             "read",
  "finance.transactions|":           "manage",
  "finance.transactions|manager":    "operate",
  "finance.transactions|viewer":     "read",
  "payroll|":                        "manage",
  "payroll|manager":                 (m) => (m === "GET" ? "read" : "operate"),
  "production.brewing|":             "admin",
  "production.brewing|brewer":       "operate",
  "production.brewing|viewer":       "read",
  "production.equipment|":           "manage",
  "production.export|":              "manage",
  "production.export|brewer":        "operate",
  "production.export|viewer,brewer,manager": "read",
  "production.inventory|":           "manage",
  "production.inventory|brewer":     "operate",
  "production.partners|":            "manage",
  "production.partners|brewer":      "operate",
  "production.partners|viewer,brewer,manager": "read",
  "production.recipes|brewer":       "operate",
  "production.settings|brewer":      "manage",
  "production.settings|manager":     "operate",
  "production.settings|brewer,manager": "operate",
  "production.settings|viewer,brewer,manager": "read",
  "settings.business|":              "manage",
  "settings.cron|":                  "read",
  "settings.users|":                 "manage",
  "taproom.performance|manager":     "operate",
  "taproom.targets|":                "manage",
  "tax|":                            "manage",
  "tax|manager":                     (m) => (m === "GET" ? "read" : "operate"),
  "tax.pii|":                        "admin",
};

// divergence resolution: master-data edit is admin-only (adopt the UI's rule)
const ROUTE_OVERRIDE = [
  [/^production\/(ingredients|packaging)\/\[id\]$/, "PATCH", "manage"],
];

const ROLES = ["viewer", "brewer", "manager", "admin"];
const legacyAllows = (role, legacy) => role === "admin" || legacy.includes(role);

const rows = readFileSync("audit94.txt", "utf8").trim().split("\n").map((l) => {
  const [route, method, legacyRaw] = l.split("|");
  const legacy = legacyRaw ? legacyRaw.split(",") : [];
  const scope = scopeFor(route);
  const path = route.replace(/\/route\.ts$/, "");
  let level = GROUP_LEVEL[`${scope}|${legacy.join(",")}`];
  if (typeof level === "function") level = level(method);
  for (const [re, m, lv] of ROUTE_OVERRIDE) if (re.test(path) && m === method) level = lv;
  return { path, method, legacy, scope, level };
});

const missing = rows.filter((r) => !r.level);
if (missing.length) { console.log("NO LEVEL:"); missing.forEach((r) => console.log("  ", r.scope, r.legacy, r.path)); }

const diffs = [];
for (const r of rows) {
  for (const role of ROLES) {
    const before = legacyAllows(role, r.legacy);
    const after = can(BUNDLES[role], r.scope, r.level);
    if (before !== after) diffs.push({ ...r, role, before, after });
  }
}

console.log(`\n=== ${rows.length} routes x 4 roles = ${rows.length * 4} assertions ===`);
console.log(`identical: ${rows.length * 4 - diffs.length}   differing: ${diffs.length}\n`);
const byReason = new Map();
for (const d of diffs) {
  const k = `${d.role} ${d.before ? "LOSES" : "GAINS"}  ${d.scope}@${d.level}`;
  if (!byReason.has(k)) byReason.set(k, []);
  byReason.get(k).push(`${d.method} ${d.path}`);
}
[...byReason.entries()].sort().forEach(([k, v]) => {
  console.log(`${k.padEnd(48)} n=${String(v.length).padStart(2)}`);
  v.slice(0, 3).forEach((x) => console.log(`      ${x}`));
  if (v.length > 3) console.log(`      … +${v.length - 3} more`);
});
