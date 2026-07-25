import type { ScopeGrants } from "./resolve";
import { ROOT } from "./scopes";

export type UserRole = "viewer" | "brewer" | "manager" | "admin" | "custom";

/**
 * The entire permission matrix, in one file. Copied verbatim from the design
 * spec's Role bundles section.
 */
export const ROLE_BUNDLES: Record<UserRole, ScopeGrants> = {
  admin: { [ROOT]: "admin" },

  manager: {
    taproom: "operate", "taproom.targets": "read",
    payroll: "operate", tax: "operate",
    "production.export": "read", "production.partners": "read",
    "production.settings": "operate",
    // no finance key — decision 6
  },

  brewer: {
    "taproom.performance": "read", "taproom.targets": "read",
    "production.brewing": "operate", "production.inventory": "operate",
    "production.export": "operate", "production.recipes": "operate",
    "production.partners": "operate", "production.settings": "manage",
    "production.equipment": "read",
  },

  viewer: { "taproom.performance": "read", "taproom.targets": "read" },

  custom: {}, // grants come from user_permission_grants
};
