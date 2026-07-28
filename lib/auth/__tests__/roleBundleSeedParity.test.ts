import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROLE_BUNDLES, type UserRole } from "../roleGrants";
import type { Level } from "../levels";
import type { ScopeGrants } from "../resolve";

/**
 * 20260826 seeds role_permission_grants from the ROLE_BUNDLES constant, and
 * getSessionUser() falls back to that same constant whenever the table cannot
 * be read. So the two are two representations of one thing — and if they drift,
 * a user's permissions change depending on whether the migration has been
 * applied yet. That is a silent, environment-dependent authorization bug, which
 * is the worst kind.
 *
 * This parses the seed straight out of the migration rather than duplicating it.
 */
const MIGRATION = join(process.cwd(), "supabase/migrations/20260826_role_permission_grants.sql");

function seedFromMigration(): Record<string, ScopeGrants> {
  const sql = readFileSync(MIGRATION, "utf8");
  const start = sql.indexOf("insert into role_permission_grants");
  expect(start, "seed INSERT not found — did the migration get renamed?").toBeGreaterThan(-1);
  const block = sql.slice(start, sql.indexOf("on conflict", start));

  const bundles: Record<string, ScopeGrants> = {};
  const row = /\(\s*'(\w+)'\s*,\s*'([^']*)'\s*,\s*'(\w+)'\s*\)/g;
  for (const m of block.matchAll(row)) {
    const [, role, scope, level] = m;
    (bundles[role] ??= {})[scope as keyof ScopeGrants] = level as Level;
  }
  return bundles;
}

describe("role bundle seed parity", () => {
  const seeded = seedFromMigration();

  it("parsed something at all", () => {
    // A regex that silently matches nothing would make every assertion below
    // vacuously pass.
    expect(Object.keys(seeded).sort()).toEqual(["admin", "brewer", "manager", "viewer"]);
  });

  it.each(["admin", "manager", "brewer", "viewer"] as UserRole[])(
    "the %s seed matches ROLE_BUNDLES exactly",
    (role) => {
      expect(seeded[role]).toEqual(ROLE_BUNDLES[role]);
    },
  );

  it("does not seed `custom` — those users resolve from user_permission_grants", () => {
    expect(seeded.custom).toBeUndefined();
    expect(ROLE_BUNDLES.custom).toEqual({});
  });
});
