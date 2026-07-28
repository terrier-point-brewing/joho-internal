import type { ScopeGrants } from "./resolve";
import { ROOT } from "./scopes";

export type UserRole = "viewer" | "brewer" | "manager" | "admin" | "custom";

/**
 * The entire permission matrix, in one file.
 *
 * Reading these: a bare section key rolls down into every leaf under it by
 * dot-prefix, so `taproom: "operate"` also covers `taproom.access` and
 * `taproom.performance`; the explicit `taproom.targets: "read"` row clamps
 * that one leaf back down. Leaf-only holders (brewer in taproom) need an
 * explicit `.access` row, because a sibling leaf grant confers nothing on its
 * section.
 *
 * Every movement from the pre-scope-restructure bundles is recorded as an
 * `intentionalChange` row in lib/auth/__fixtures__/legacy-matrix.ts.
 */
export const ROLE_BUNDLES: Record<UserRole, ScopeGrants> = {
  admin: { [ROOT]: "admin" },

  manager: {
    taproom: "operate", "taproom.targets": "read",
    payroll: "operate",
    "production.access": "read",
    "production.export": "read", "production.partners": "read",
    "production.settings": "operate",
    // No finance key of any kind, and no `catalog` key. The tax grant that
    // used to sit here was unreachable — every tax screen lives under
    // /finance, which manager cannot enter — so it was removed rather than
    // made real. Manager holds no `manage` anywhere, which is what keeps the
    // settings hub empty for them; restoring any of this is a grant edit, not
    // a code change.
  },

  brewer: {
    "taproom.access": "read",
    "taproom.performance": "read", "taproom.targets": "read",
    "production.access": "read",
    "production.brewing": "operate", "production.inventory": "operate",
    "production.export": "operate", "production.recipes": "operate",
    "production.partners": "operate", "production.settings": "manage",
    "production.equipment": "read",
    // Square Item Mappings — re-keyed from the production.settings grant that
    // used to carry it.
    catalog: "manage",
    // Excise rates are tax reference data rendered inside Export Settings.
    // A leaf-only grant: it confers nothing else in finance.
    "finance.tax.filing": "read",
  },

  viewer: {
    "taproom.access": "read",
    "taproom.performance": "read", "taproom.targets": "read",
  },

  custom: {}, // grants come from user_permission_grants
};
