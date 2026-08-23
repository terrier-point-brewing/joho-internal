/**
 * The scope tree models the DOMAIN — what a permission protects — and nothing
 * else. Two things it deliberately does NOT model:
 *
 *   * WHERE a screen is mounted. Nav tabs and routes are mounting points that
 *     carry zero authority. Moving a screen, or mounting one component at two
 *     routes, never renames a scope. Admission to a section is its own leaf
 *     (`<section>.access`, read-gated in that section's layout) so no content
 *     scope has to moonlight as a door.
 *
 *   * HOW MUCH power. That is the level ladder in ./levels. "Settings" is a
 *     level, not a place: a settings screen is the `manage` face of a domain
 *     that already exists, so there is no `settings.*` family. Likewise a
 *     light-vs-full surface pair (taproom payroll vs finance payroll) is one
 *     scope at two depths, never two scopes.
 *
 * Placement rule: consumed by one section -> leaf under that section's family;
 * consumed by two or more -> top-level, owned by neither (`payroll`,
 * `catalog`); a subtab needing finer gating than its parent domain -> sub-leaf
 * (`finance.tax.filing`).
 *
 * Thirty-two leaves across eight families. Interior nodes are grantable too:
 * `finance.tax` is a real key, and a bare `finance` grant rolls down into all
 * of `finance.tax.*` by dot-prefix. A SIBLING leaf grant confers nothing on its
 * section — `finance.tax:operate` does not resolve `finance.access` — which is
 * what lets tax nest under finance without widening anyone into finance.
 */
export type Section =
  | "taproom"
  | "production"
  | "finance"
  | "payroll"
  | "catalog"
  | "brand"
  | "marketing"
  | "org";

export const SCOPES = {
  "taproom.access": { label: "Access", section: "taproom" },
  "taproom.performance": { label: "Performance", section: "taproom" },
  "taproom.targets": { label: "Targets", section: "taproom" },

  "production.access": { label: "Access", section: "production" },
  "production.brewing": { label: "Brewing", section: "production" },
  "production.inventory": { label: "Inventory", section: "production" },
  "production.export": { label: "Export", section: "production" },
  "production.recipes": { label: "Recipes", section: "production" },
  "production.partners": { label: "Partners", section: "production" },
  "production.equipment": { label: "Equipment", section: "production" },
  "production.settings": { label: "Settings", section: "production" },

  "finance.access": { label: "Access", section: "finance" },
  "finance.statements": { label: "Statements", section: "finance" },
  "finance.transactions": { label: "Transactions", section: "finance" },
  "finance.tax": { label: "Tax", section: "finance" },
  "finance.tax.filing": { label: "Tax · Filing", section: "finance" },
  "finance.tax.pii": { label: "Tax · PII", section: "finance" },

  // Two surfaces, one scope: the taproom-side payroll view renders only
  // affordances needing read/operate, the finance-side one exposes through
  // manage. The masking is presentation; the APIs enforce the real level.
  payroll: { label: "Payroll", section: "payroll" },

  // The Square Item Mappings CONFIGURATION — viewing and editing the mapping
  // list itself. Data merely computed through those mappings (taproom
  // consumption, sell-through, export invoice previews) stays on its own
  // domain scope; gating it here would drag `catalog` across half the app.
  catalog: { label: "Catalog", section: "catalog" },

  "brand.access": { label: "Access", section: "brand" },
  "brand.guide": { label: "Guide", section: "brand" },
  "brand.assets": { label: "Assets", section: "brand" },
  "brand.releases": { label: "Releases", section: "brand" },
  // Authoring templates and seasons — rare, structural, and separate from
  // producing artifacts with them. Someone who lays out a hundred labels should
  // not thereby be able to change the chassis every label is built on.
  "brand.templates": { label: "Templates", section: "brand" },
  // Producing and approving outputs. `operate` drafts a render; `manage`
  // approves and exports one, which is the human gate nothing may skip.
  "brand.outputs": { label: "Outputs", section: "brand" },

  // Marketing. One further leaf is DESIGNED AND DELIBERATELY DEFERRED, named
  // here so the next chip does not re-litigate it:
  //
  //   * `marketing.calendar` — the entry calendar and the rows on it. Arrives
  //     with the chip that adds the entry routes.
  //
  // It is absent rather than pre-registered because
  // scripts/check-permissions.mjs fails on a scope no capability covers AND on
  // a capability nothing references, so a scope landing ahead of its caller
  // would break the build on the day it shipped.
  "marketing.access": { label: "Access", section: "marketing" },
  // Connected channel logins — the leaf that will hold tokens, which is why it
  // is its own scope rather than a facet of the calendar.
  "marketing.accounts": { label: "Accounts", section: "marketing" },
  // Pushing a scheduled entry out through a channel, and putting a failed one
  // back on the queue. Separate from the calendar on purpose: deciding WHAT
  // goes out is editing a row, and deciding that it goes out NOW is an act
  // nobody can take back.
  "marketing.publish": { label: "Publish", section: "marketing" },

  "org.users": { label: "Users", section: "org" },
  "org.business": { label: "Business", section: "org" },
  "org.jobs": { label: "Cron Jobs", section: "org" },
  // App-wide reskin. Split out of brand.guide, which used to conflate editing
  // brand CONTENT with restyling the internal app for every user.
  "org.appearance": { label: "Appearance", section: "org" },
} as const satisfies Record<string, { label: string; section: Section }>;

/** Derived from the const, so a typo is a compile error rather than a runtime 403. */
export type ScopeKey = keyof typeof SCOPES;

export const ROOT = "" as const;
