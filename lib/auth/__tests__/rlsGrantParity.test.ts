import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RANK, type Level } from "../levels";
import { can, effectiveLevel, type ScopeGrants } from "../resolve";
import type { ScopeKey } from "../scopes";

/**
 * Guards the SQL <-> TS mirror introduced by
 * 20260822_rls_grant_aware_policies.sql. The repo has no Postgres in the test
 * environment, so these assertions do two things instead of executing SQL:
 *
 *   1. Pin the couplings the SQL silently depends on (enum declaration order,
 *      the set of tables that need grant policies).
 *   2. Transliterate the SQL resolver into TS and cross-check it against
 *      resolve.ts over a case matrix, so a change to RANK or to the
 *      longest-prefix rule fails here rather than in production.
 *
 * Design: docs/superpowers/specs/2026-07-27-rls-grant-aware-policies-design.md
 */

const MIGRATIONS = join(process.cwd(), "supabase", "migrations");
const GRANT_MIGRATION = "20260822_rls_grant_aware_policies.sql";
const GRANTS_MIGRATION = "20260820_user_permission_grants.sql";
// 20260826 REDEFINES effective_grant_level to span role bundles too, so it —
// not 20260822 — is the current definition and the one to assert against.
const ROLE_MIGRATION = "20260826_role_permission_grants.sql";
// 20260826's function half never took effect in prod (its table half did), so
// this file re-applies the SAME body under a fresh version. See its header.
const REPAIR_MIGRATION = "20261002090000_repair_effective_grant_level_role_bundles.sql";

const read = (file: string) => readFileSync(join(MIGRATIONS, file), "utf8");

/** The `create or replace function public.effective_grant_level ... $fn$;` block. */
function resolverBody(sql: string): string {
  const match = sql.match(
    /create or replace function public\.effective_grant_level[\s\S]*?\$fn\$([\s\S]*?)\$fn\$;/,
  );
  if (!match) throw new Error("effective_grant_level definition not found");
  return match[1].trim();
}

/** Pulls the string literals out of a `array['a','b',...]` SQL literal. */
function sqlArrayLiteral(block: string): string[] {
  const match = block.match(/array\s*\[([^\]]*)\]/i);
  if (!match) return [];
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The rank comparison rides on Postgres enum ordering
// ─────────────────────────────────────────────────────────────────────────────

describe("permission_level enum ordering", () => {
  it("is declared in the same order as RANK, which is what makes `level >= need` a rank check", () => {
    const sql = read(GRANTS_MIGRATION);
    const decl = sql.match(/create type permission_level as enum\s*\(([^)]*)\)/i);

    expect(decl, "permission_level enum declaration not found").toBeTruthy();

    const enumOrder = [...decl![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    const rankOrder = (Object.keys(RANK) as Level[]).sort((a, b) => RANK[a] - RANK[b]);

    // has_grant() compares `effective_grant_level(scope) >= p_need` and relies
    // entirely on enum declaration order for that to mean what can() means.
    expect(enumOrder).toEqual(rankOrder);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Coverage — no payroll table left behind
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every table carrying a `payroll readers` policy anywhere in the migration
 * tree. Two shapes exist: an explicit `on public.<table>`, and a DO-block loop
 * that applies the policy over an array via `%I`. The loop form is picked up by
 * finding the `do $$ ... $$` segment that references payroll_reader_roles().
 */
function payrollGatedTables(): Set<string> {
  const tables = new Set<string>();

  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql"))) {
    if (file === GRANT_MIGRATION) continue;
    const sql = read(file);
    if (!sql.includes("payroll_reader_roles")) continue;

    for (const m of sql.matchAll(/create policy\s+"payroll readers"\s+on\s+public\.(\w+)/gi)) {
      tables.add(m[1]);
    }

    // Loop form: only the DO segment that actually uses payroll_reader_roles()
    // — the same file's finance segment must not be swept in.
    for (const segment of sql.split(/\bdo\s+\$\$/i).slice(1)) {
      const body = segment.split(/\$\$\s*;/)[0];
      if (!body.includes("payroll_reader_roles")) continue;
      sqlArrayLiteral(body).forEach((t) => tables.add(t));
    }
  }

  return tables;
}

describe("grant-policy coverage", () => {
  const migration = read(GRANT_MIGRATION);
  const applied = new Set(sqlArrayLiteral(migration.split(/\bdo\s+\$\$/i)[1] ?? ""));

  it("covers every table gated by payroll_reader_roles()", () => {
    const gated = payrollGatedTables();

    // Sanity: the discovery above actually found the known groups, so a broken
    // regex reads as a failure rather than a vacuous pass.
    expect(gated.has("payroll_entries")).toBe(true);
    expect(gated.has("employees")).toBe(true);
    expect(gated.has("payroll_gl_report_totals")).toBe(true);
    expect(gated.size).toBeGreaterThanOrEqual(9);

    const missing = [...gated].filter((t) => !applied.has(t));
    expect(missing, `payroll tables without grant policies: ${missing.join(", ")}`).toEqual([]);
  });

  it("also covers payroll_shift_overrides, whose migration is still on PR #277", () => {
    // to_regclass in apply_grant_policies makes this a no-op until 20260821
    // lands, so listing it early is safe and closes the ordering gap.
    expect(applied.has("payroll_shift_overrides")).toBe(true);
  });

  it("does not extend grant policies to the service-role-only finance group", () => {
    // finance_reader_roles() is an empty array on purpose: those tables are
    // admin-client only, so adding policies would OPEN a closed surface.
    for (const table of ["expenses", "chart_of_accounts", "expense_gl_splits", "payroll_period_expense_matches"]) {
      expect(applied.has(table), `${table} should stay service-role-only`).toBe(false);
    }
  });

  it("leaves the existing payroll readers policies untouched", () => {
    // Additive-only is what guarantees manager/admin cannot regress.
    expect(migration).not.toMatch(/drop policy[^\n]*"payroll readers"/i);
    expect(migration).not.toMatch(/create or replace function public\.payroll_reader_roles/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Resolver semantics — SQL transliterated, cross-checked against resolve.ts
// ─────────────────────────────────────────────────────────────────────────────

describe("SQL resolver mirrors lib/auth/resolve.ts", () => {
  const migration = read(GRANT_MIGRATION);
  const current = read(ROLE_MIGRATION);

  it("still gates PER-USER rows on role = custom, mirroring getSessionUser", () => {
    expect(current).toMatch(/get_my_role\(\)\s*=\s*'custom'::user_role/);
  });

  it("resolves ROLE bundles for every role, not just custom", () => {
    // The regression this guards is precise and severe: if the resolver goes
    // back to short-circuiting on custom, Postgres denies every non-custom
    // user the payroll tables their bundle authorizes — the app allows, the DB
    // refuses. That is the divergence 20260822 existed to fix, reintroduced
    // from the other side.
    expect(current).toMatch(/from public\.role_permission_grants r/);
    expect(current).toMatch(/where r\.role = public\.get_my_role\(\)/);
    expect(current).toMatch(/union all/i);
  });

  it("uses starts_with rather than LIKE for the dot-prefix arm", () => {
    // LIKE would treat an underscore in a future scope key as a wildcard.
    expect(migration).toContain("starts_with(p_scope, g.scope || '.')");
    expect(current).toContain("starts_with(p_scope, c.scope || '.')");
    expect(current).not.toMatch(/p_scope\s+like/i);
  });

  it("resolves longest-prefix-wins, with a per-user row outranking a role row", () => {
    expect(migration).toMatch(/order by length\(g\.scope\) desc\s*\n?\s*limit 1/i);
    expect(current).toMatch(/order by length\(c\.scope\) desc,\s*c\.precedence desc\s*\n?\s*limit 1/i);
  });

  it("denies when no grant matches", () => {
    expect(migration).toContain("coalesce(public.effective_grant_level(p_scope) >= p_need, false)");
  });

  it("wraps policy predicates in (select ...) so they plan as an InitPlan", () => {
    const predicates = migration.match(/public\.has_grant\(/g) ?? [];
    const wrapped = migration.match(/\(select public\.has_grant\(/g) ?? [];
    // Every call inside apply_grant_policies is wrapped; the two in the
    // comment/signature lines are not policy predicates.
    expect(wrapped.length).toBe(3);
    expect(predicates.length).toBeGreaterThanOrEqual(wrapped.length);
  });
});

// ── The transliteration itself ──────────────────────────────────────────────

type GrantRow = { scope: string; level: Level };
type Role = "viewer" | "brewer" | "manager" | "admin" | "custom";

/**
 * Line-by-line equivalent of public.effective_grant_level() as redefined by
 * 20260826 — the UNION of the caller's per-user rows (custom only) and their
 * role's bundle (any role).
 */
function sqlEffectiveGrantLevel(
  role: Role,
  rows: GrantRow[],
  scope: string,
  roleRows: GrantRow[] = [],
): Level | null {
  const candidates = [
    // the per-user arm keeps its `get_my_role() = custom` gate
    ...(role === "custom" ? rows.map((r) => ({ ...r, precedence: 1 })) : []),
    ...roleRows.map((r) => ({ ...r, precedence: 0 })),
  ];

  const matching = candidates.filter(
    (r) => r.scope === "" || r.scope === scope || scope.startsWith(r.scope + "."),
  );
  if (matching.length === 0) return null;

  // order by length(c.scope) desc, c.precedence desc limit 1
  return [...matching].sort(
    (a, b) => b.scope.length - a.scope.length || b.precedence - a.precedence,
  )[0].level;
}

/** Line-by-line equivalent of public.has_grant(), incl. enum-ordinal compare. */
function sqlHasGrant(role: Role, rows: GrantRow[], scope: string, need: Level): boolean {
  const level = sqlEffectiveGrantLevel(role, rows, scope);
  return level === null ? false : RANK[level] >= RANK[need];
}

/** How getSessionUser() turns grant rows into the ScopeGrants object. */
const toGrants = (rows: GrantRow[]): ScopeGrants =>
  Object.fromEntries(rows.map((r) => [r.scope, r.level])) as ScopeGrants;

const CASES: { name: string; rows: GrantRow[]; scope: ScopeKey }[] = [
  { name: "exact match", rows: [{ scope: "payroll", level: "operate" }], scope: "payroll" },
  { name: "no grant at all", rows: [], scope: "payroll" },
  { name: "unrelated grant only", rows: [{ scope: "finance.tax", level: "admin" }], scope: "payroll" },
  { name: "explicit none revoke", rows: [{ scope: "payroll", level: "none" }], scope: "payroll" },
  {
    name: "ROOT cascade",
    rows: [{ scope: "", level: "manage" }],
    scope: "payroll",
  },
  {
    name: "ROOT loses to a longer key",
    rows: [
      { scope: "", level: "admin" },
      { scope: "payroll", level: "read" },
    ],
    scope: "payroll",
  },
  {
    name: "section cascades to a leaf",
    rows: [{ scope: "production", level: "operate" }],
    scope: "production.brewing",
  },
  {
    name: "leaf key overrides its section",
    rows: [
      { scope: "production", level: "admin" },
      { scope: "production.brewing", level: "read" },
    ],
    scope: "production.brewing",
  },
  {
    // Three segments deep, and the revoke sits on the deepest key — the SQL
    // resolver orders by length, so this is where an off-by-one would show.
    name: "sub-leaf revoke under an interior-node grant",
    rows: [
      { scope: "finance.tax", level: "manage" },
      { scope: "finance.tax.pii", level: "none" },
    ],
    scope: "finance.tax.pii",
  },
  {
    name: "sibling leaf keeps the section level",
    rows: [
      { scope: "production", level: "admin" },
      { scope: "production.brewing", level: "read" },
    ],
    scope: "production.recipes",
  },
];

const LEVELS: Level[] = ["none", "read", "operate", "manage", "admin"];

describe("SQL/TS parity over the grant matrix", () => {
  it.each(CASES)("$name resolves identically", ({ rows, scope }) => {
    expect(sqlEffectiveGrantLevel("custom", rows, scope)).toBe(effectiveLevel(toGrants(rows), scope));

    for (const need of LEVELS) {
      expect(
        sqlHasGrant("custom", rows, scope, need),
        `${scope} needs ${need}`,
      ).toBe(can(toGrants(rows), scope, need));
    }
  });

  it("denies every non-custom role, since only custom reads user_permission_grants", () => {
    const rows: GrantRow[] = [{ scope: "", level: "admin" }];

    for (const role of ["viewer", "brewer", "manager", "admin"] as Role[]) {
      expect(sqlEffectiveGrantLevel(role, rows, "payroll")).toBeNull();
      expect(sqlHasGrant(role, rows, "payroll", "read")).toBe(false);
    }

    // manager/admin still reach payroll — via the untouched "payroll readers"
    // policy, not via this path.
    expect(sqlHasGrant("custom", rows, "payroll", "read")).toBe(true);
  });

  it("treats the prefix check as dot-delimited, not a bare string prefix", () => {
    const rows: GrantRow[] = [{ scope: "finance.tax", level: "admin" }];

    // "finance.taxes.foo" is not a real ScopeKey, but the SQL operates on raw
    // text and must not match it — same trap resolve.ts documents.
    expect(sqlEffectiveGrantLevel("custom", rows, "finance.taxes.foo")).toBeNull();
    expect(effectiveLevel(toGrants(rows), "finance.taxes.foo" as ScopeKey)).toBeNull();

    expect(sqlEffectiveGrantLevel("custom", rows, "finance.tax.pii")).toBe("admin");
  });

  it("gives payroll:read DB reads but not DB writes, matching the policy split", () => {
    const rows: GrantRow[] = [{ scope: "payroll", level: "read" }];

    expect(sqlHasGrant("custom", rows, "payroll", "read")).toBe(true); // "grant read"
    expect(sqlHasGrant("custom", rows, "payroll", "operate")).toBe(false); // "grant write"
  });

  it("gives payroll:operate both, which is what PR #277's day-override grid needs", () => {
    const rows: GrantRow[] = [{ scope: "payroll", level: "operate" }];

    expect(sqlHasGrant("custom", rows, "payroll", "read")).toBe(true);
    expect(sqlHasGrant("custom", rows, "payroll", "operate")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Role bundles as data (20260826) — the union arm
// ─────────────────────────────────────────────────────────────────────────────

describe("role bundle resolution", () => {
  const managerBundle: GrantRow[] = [
    { scope: "payroll", level: "operate" },
    { scope: "taproom", level: "operate" },
    { scope: "taproom.targets", level: "read" },
  ];

  it("resolves a non-custom role from its bundle, where it used to resolve nothing", () => {
    // Before 20260826 this returned null for every non-custom role, which was
    // correct only while bundles lived exclusively in TS.
    expect(sqlEffectiveGrantLevel("manager", [], "payroll", managerBundle)).toBe("operate");
    expect(sqlHasGrant("manager", [], "payroll", "operate")).toBe(false); // no bundle passed
  });

  it("applies longest-prefix-wins across the bundle exactly as resolve.ts does", () => {
    const grants = toGrants(managerBundle);
    for (const scope of ["taproom.performance", "taproom.targets", "payroll"] as ScopeKey[]) {
      expect(sqlEffectiveGrantLevel("manager", [], scope, managerBundle)).toBe(
        effectiveLevel(grants, scope),
      );
    }
  });

  it("gives a per-user row precedence over a role row at the same key", () => {
    // Only reachable if `custom` is ever given a base bundle. Modelled anyway,
    // because the SQL's ORDER BY says so and silent disagreement is the whole
    // failure mode this file guards.
    const userRows: GrantRow[] = [{ scope: "payroll", level: "none" }];
    const roleRows: GrantRow[] = [{ scope: "payroll", level: "manage" }];
    expect(sqlEffectiveGrantLevel("custom", userRows, "payroll", roleRows)).toBe("none");
  });

  it("keeps ignoring per-user rows for non-custom roles", () => {
    const userRows: GrantRow[] = [{ scope: "payroll", level: "admin" }];
    expect(sqlEffectiveGrantLevel("brewer", userRows, "payroll", [])).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. The prod repair (20261002) re-applies 20260826's body, not a variant
// ─────────────────────────────────────────────────────────────────────────────

describe("effective_grant_level repair migration", () => {
  it("carries a body identical to 20260826's, so the two cannot drift", () => {
    // Everything in section 3 asserts against ROLE_MIGRATION. If the repair
    // that actually reaches prod said something different, those assertions
    // would be checking a file no database runs.
    expect(resolverBody(read(REPAIR_MIGRATION))).toBe(resolverBody(read(ROLE_MIGRATION)));
  });

  it("takes a version no other migration uses", () => {
    // Sharing a version is exactly how 20260826's function half got skipped.
    const version = REPAIR_MIGRATION.split("_")[0];
    const sharing = readdirSync(MIGRATIONS).filter(
      (f) => f.endsWith(".sql") && f.split("_")[0] === version,
    );
    expect(sharing).toEqual([REPAIR_MIGRATION]);
  });

  it("re-asserts EXECUTE for authenticated and withholds it from anon", () => {
    const sql = read(REPAIR_MIGRATION);
    expect(sql).toMatch(/grant execute on function public\.effective_grant_level\(text\) to authenticated/);
    expect(sql).toMatch(/revoke execute on function public\.effective_grant_level\(text\) from anon, public/);
  });

  it("does not reopen the finance group that finance_reader_roles() keeps shut", () => {
    // Widening those 14 tax/finance tables is a separate decision; this file
    // must stay a pure repair of the resolver. Comments are stripped first —
    // the header discusses both names at length, and prose is not an effect.
    const statements = read(REPAIR_MIGRATION)
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(statements).not.toMatch(/finance_reader_roles/);
    expect(statements).not.toMatch(/apply_grant_policies/);
    expect(statements).not.toMatch(/create policy|drop policy/i);
  });
});
