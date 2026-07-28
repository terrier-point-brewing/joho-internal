// Barrel — preserves the @/lib/auth import path the ~211 existing call
// sites use. lib/auth.ts is retired in favor of this directory.
export { getSessionUser } from "./session";
export type { Session } from "./session";

export { requirePermission } from "./guard";
export { requirePage, redirectToFirstReachable } from "./requirePage";

export { can, effectiveLevel } from "./resolve";
export type { ScopeGrants } from "./resolve";

export { CAP } from "./capabilities";
export type { Capability } from "./capabilities";

export { ROLE_BUNDLES } from "./roleGrants";
export type { UserRole } from "./roleGrants";

export { SCOPES, ROOT } from "./scopes";
export type { ScopeKey, Section } from "./scopes";

export { RANK } from "./levels";
export type { Level } from "./levels";

// NOTE: this barrel re-exports getSessionUser, which reaches next/headers via
// lib/supabase/server.ts. Importing it from a "use client" module pulls
// server-only code into the client bundle and breaks `npm run build` while
// `npm run verify` still passes. Client code must import CAP from
// ./capabilities, can from ./resolve, and SCOPES from ./scopes directly.
// Enforced by scripts/check-permissions.mjs.
