# Scoped Permissions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fifth `custom` role backed by per-user scope+level grants, re-expressing the four existing roles as static grant bundles so both share one resolver.

**Execution Budget:** Mode = subagent-driven-development (~200 files, 9 locality groups — above the CLAUDE.md inline tier). **Spawn cap = 11** (9 groups + 2). Token target ≈ 900k. The executor STOPS and reports before exceeding the spawn cap.

**Architecture:** Roles and custom grants collapse to one data structure (`ScopeGrants`). `getSessionUser` resolves a role's bundle or a custom user's rows into that one shape, so no enforcement layer knows which source it came from. Twenty hierarchical scopes × a four-rung ordered ladder (`read < operate < manage < admin`), resolved longest-prefix-wins. Named capabilities in `lib/auth/capabilities.ts` are imported by both the route and the component that gate the same action, making UI/API divergence structurally impossible.

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase Postgres, Vitest, TanStack Query.

**Spec:** `docs/superpowers/specs/2026-07-25-scoped-permissions-design.md` — the appendix there is the authoritative route → scope + level table.

**Validation harness:** `docs/superpowers/specs/2026-07-25-scoped-permissions-validation/` — `verify.mjs` replays all 211 routes against the bundle table. Run it after any bundle or level edit.

## Global Constraints

- **No implementation bodies in briefs.** Subagent briefs carry interfaces, signatures, acceptance criteria and test cases only. Inline code ≤ 20 lines per task.
- **Subagent briefs end with the mandatory footer:** "This brief is authoritative and self-contained — do NOT read the plan, spec, CLAUDE.md, or UI_STANDARD.md unless an Extended Documentation Trigger fires."
- **Route implementation and mechanical spawns go to the lean `impl` agent type** (`subagent_type: "impl"`), with the per-task `model` from the table below.
- **Subagents NEVER apply migrations to prod.** Migration files are written and committed only. Application is orchestrator-only, after explicit user OK plus a backup.
- **`npm run verify`** (lint + typecheck + tests) is the per-task definition of done.
- **No raw colors, no hand-rolled primitives** in any UI task — token utilities and `app/components/ui/` primitives only (`docs/UI_STANDARD.md`).
- **Co-located `*.test.ts`** for every new or modified `lib/` module. Do not drop `lib/` coverage below the `vitest.config.ts` floor.
- **Commit after every task.** Parallel subagents in a shared worktree wipe each other's work if uncommitted.
- Work happens in worktree `.claude/worktrees/scoped-permissions-a1b2c3` on branch `claude/scoped-permissions`.

## Task Table

| # | Task | Group | Model | Depends on |
|---|---|---|---|---|
| 1 | Migrations: `custom` enum + grants table | G1 foundation | haiku | — |
| 2 | `lib/auth`: levels, scopes, resolve | G1 foundation | sonnet | 1 |
| 3 | `lib/auth`: roleGrants + capabilities | G1 foundation | sonnet | 2 |
| 4 | `lib/auth`: session, guard, barrel, `/api/auth/me`, `usePermissions` | G1 foundation | sonnet | 3 |
| 5 | Equivalence fixture + test | G2 harness | haiku | 4 |
| 6 | Convert production routes (82 sites) | G3 | sonnet | 5 |
| 7 | Convert finance + payroll routes (67 sites) | G4 | sonnet | 5 |
| 8 | Convert tax/brand/admin/settings/taproom routes (62 sites) | G5 | sonnet | 5 |
| 9 | Layouts + nav configs | G6 | sonnet | 5 |
| 10 | UI inline role checks → `usePermissions` | G7 | sonnet | 9 |
| 11 | Admin UI: grants matrix + grants API | G8 | sonnet | 4 |
| 12 | CI guards + delete `requireRole` | G9 | haiku | 6,7,8,9,10,11 |
| 13 | Final whole-branch review | G9 | opus | 12 |

Tasks 6, 7 and 8 are independent and may run in parallel. Task 10 follows 9 because both touch role-reading components.

---

## File Structure

**New — `lib/auth/` (replaces the single `lib/auth.ts`):**

| File | Responsibility |
|---|---|
| `index.ts` | Barrel. Re-exports `getSessionUser`, `UserRole`, `requirePermission`, `can`, `CAP`. Preserves the ~200 existing `@/lib/auth` imports |
| `levels.ts` | `Level` type, `RANK` |
| `scopes.ts` | `SCOPES` const, `ScopeKey`, `Section`, `ROOT` |
| `roleGrants.ts` | `ROLE_BUNDLES` |
| `capabilities.ts` | `CAP` — the permission manifest |
| `resolve.ts` | `effectiveLevel`, `can` — pure |
| `session.ts` | `getSessionUser` — I/O |
| `guard.ts` | `requirePermission` — throws `Response` |
| `__fixtures__/legacy-matrix.ts` | 211 rows generated from the validation harness |

**Modified:** ~160 route files, 11 layout/nav files, 24 files with inline role checks, `lib/hooks/useUserRole.ts`, `app/api/auth/me/route.ts`, `app/settings/users/UserManagement.tsx`.

**Deleted:** `lib/auth.ts` (becomes `lib/auth/index.ts`), `requireRole` (task 12).

---

## Task 1: Migrations

**Files:**
- Create: `supabase/migrations/20260726_user_role_custom.sql`
- Create: `supabase/migrations/20260727_user_permission_grants.sql`

**Interfaces:**
- Produces: `user_role` enum gains `'custom'`; table `user_permission_grants(user_id, scope, level, granted_by, granted_at)`; enum `permission_level`.

**Why two files:** `ALTER TYPE … ADD VALUE` cannot be *used* in the transaction that adds it, and Supabase runs each migration file in one transaction. Distinct date prefixes — the CLI keys on the digits before the first `_`, so same-day prefixes collide.

- [ ] **Step 1: Write `20260726_user_role_custom.sql`**

```sql
alter type user_role add value 'custom';
```

- [ ] **Step 2: Write `20260727_user_permission_grants.sql`**

Must contain, in order: `create type permission_level as enum ('read','operate','manage','admin')`; the table per the spec's Schema section; `alter table … enable row level security`; and exactly one policy:

```sql
create policy "users read own grants" on user_permission_grants
  for select to authenticated using (user_id = auth.uid());
```

**No authenticated write policy** — writes go through the admin (service_role) client only.

**Acceptance criteria:**
- `getSessionUser` reads through the *server* client; without the select policy every custom user silently resolves to zero permissions. The policy is not optional.
- No other RLS policy in the repo is modified.

- [ ] **Step 3: Verify no same-day prefix collision**

Run: `ls supabase/migrations/ | grep -E '^2026072[67]'`
Expected: only the two new files.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/
git commit -m "feat(auth): migrations for custom role and per-user permission grants"
```

**DO NOT apply these to prod.** Orchestrator applies after explicit user OK plus backup.

---

## Task 2: `lib/auth` — levels, scopes, resolve

**Files:**
- Create: `lib/auth/levels.ts`, `lib/auth/scopes.ts`, `lib/auth/resolve.ts`
- Test: `lib/auth/resolve.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
```ts
export type Level = "read" | "operate" | "manage" | "admin";
export const RANK: Record<Level, number>;                 // read:1 … admin:4
export const SCOPES: Record<ScopeKey, { label: string; section: Section }>;
export type ScopeKey;                                      // derived from SCOPES via `as const`
export type Section = "taproom"|"production"|"finance"|"payroll"|"tax"|"brand"|"settings";
export const ROOT: "";
export type ScopeGrants = Partial<Record<ScopeKey | Section | typeof ROOT, Level>>;
export function effectiveLevel(grants: ScopeGrants, scope: ScopeKey): Level | null;
export function can(grants: ScopeGrants, scope: ScopeKey, need: Level): boolean;
```

The 20 scope keys are listed verbatim in the spec's Scopes section. `ScopeKey` must be derived from the const (`keyof typeof SCOPES`) so a typo is a compile error.

**The one non-obvious piece** — longest-prefix matching:

```ts
// a key matches when it is ROOT, equals the scope, or is a dot-prefix of it;
// the longest matching key supplies the level
const matches = key === ROOT || scope === key || scope.startsWith(key + ".");
```

- [ ] **Step 1: Write `lib/auth/resolve.test.ts` (failing)**

Required cases:
| Case | Expectation |
|---|---|
| exact key match | `{"finance.statements":"read"}` → `effectiveLevel(…, "finance.statements") === "read"` |
| section cascades to leaf | `{finance:"read"}` → `effectiveLevel(…, "finance.statements") === "read"` |
| longer key overrides shorter | `{finance:"admin","finance.statements":"read"}` → `"read"` for `finance.statements`, `"admin"` for `finance.transactions` |
| ROOT matches everything | `{"":"admin"}` → `"admin"` for every scope |
| ROOT loses to any specific key | `{"":"read","tax.pii":"admin"}` → `"admin"` for `tax.pii` |
| no match | `{}` → `null`; `can(…)` false |
| ladder is inclusive | `manage` grant satisfies `need: "read"` and `need: "operate"` |
| ladder is not reversible | `operate` grant does **not** satisfy `need: "manage"` |
| prefix is dot-delimited, not substring | `{"tax":"admin"}` must NOT match a hypothetical scope `taxes.foo` |

That last case is the trap: a naive `scope.startsWith(key)` makes `tax` match `taxes.*`. The test must pin it.

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run lib/auth/resolve.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the three modules**

- [ ] **Step 4: Run and confirm pass**

Run: `npx vitest run lib/auth/resolve.test.ts` → PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add lib/auth/
git commit -m "feat(auth): scope/level model and longest-prefix resolver"
```

---

## Task 3: `lib/auth` — roleGrants + capabilities

**Files:**
- Create: `lib/auth/roleGrants.ts`, `lib/auth/capabilities.ts`
- Test: `lib/auth/roleGrants.test.ts`

**Interfaces:**
- Consumes: `ScopeGrants`, `ScopeKey`, `Level` from task 2.
- Produces:
```ts
export type UserRole = "viewer" | "brewer" | "manager" | "admin" | "custom";
export const ROLE_BUNDLES: Record<UserRole, ScopeGrants>;
export interface Capability { scope: ScopeKey; level: Level }
export const CAP: Record<string, Capability>;
```

`ROLE_BUNDLES` is copied **verbatim** from the spec's Role bundles section — including the absent finance key on `manager` (decision 6) and the empty `custom: {}`.

`CAP` entries are derived from the spec appendix: every distinct (scope, level) pair that appears, named by intent. Names referenced elsewhere in this plan and which must exist: `brewingOperate`, `ingredientMasterEdit`, `packagingMasterEdit`, `batchDelete`, `targetsEdit`, `taxPiiReveal`, `usersManage`, `brandGuideRead`, `brandGuideManage`, `financeStatementsRead`, `financeTransactionsManage`.

Note that `ingredientMasterEdit` and `packagingMasterEdit` resolve to the same `(production.inventory, manage)` pair. That duplication is intentional — capabilities name the *intent*, so the two inventory tabs each gate on a name that reads correctly at the call site.

- [ ] **Step 1: Write `lib/auth/roleGrants.test.ts` (failing)**

Required cases:
- Every scope key used in `ROLE_BUNDLES` exists in `SCOPES` or is a valid `Section` or `ROOT`.
- Every `CAP` entry's `scope` exists in `SCOPES`.
- `ROLE_BUNDLES.admin` grants `admin` on all 20 scopes.
- `ROLE_BUNDLES.custom` is empty.
- `ROLE_BUNDLES.manager` has **no** key resolving to any finance scope — assert `effectiveLevel(ROLE_BUNDLES.manager, "finance.transactions") === null` and the same for `finance.statements`.
- `ROLE_BUNDLES.manager` resolves `taproom.targets` → `read` while `taproom.performance` → `operate` (the Targets rule).

- [ ] **Step 2: Run and confirm failure**
- [ ] **Step 3: Implement both modules**
- [ ] **Step 4: Run and confirm pass**

- [ ] **Step 5: Cross-check against the validation harness**

```bash
cd docs/superpowers/specs/2026-07-25-scoped-permissions-validation && node verify.mjs
```
Expected: `identical: 816   differing: 28`. If the count differs, `ROLE_BUNDLES` was transcribed wrong — fix before committing.

- [ ] **Step 6: Commit**

---

## Task 4: `lib/auth` — session, guard, barrel, client plumbing

**Files:**
- Create: `lib/auth/session.ts`, `lib/auth/guard.ts`, `lib/auth/index.ts`
- Delete: `lib/auth.ts`
- Modify: `app/api/auth/me/route.ts`, `lib/hooks/useUserRole.ts`
- Test: `lib/auth/session.test.ts`

**Interfaces:**
- Consumes: everything from tasks 2–3.
- Produces:
```ts
export interface Session { user: User; role: UserRole; grants: ScopeGrants }
export async function getSessionUser(): Promise<Session | null>;
export async function requirePermission(cap: Capability): Promise<Session>;  // throws Response 401/403
export function usePermissions(): { can: (cap: Capability) => boolean; role: UserRole | null; loading: boolean };
```

**Resolution rule** — the load-bearing line:

```ts
const grants = role === "custom"
  ? Object.fromEntries(rows.map(r => [r.scope, r.level]))
  : ROLE_BUNDLES[role];
```

Grants are consulted **only** when `role === "custom"`. The four existing roles never read the grants table.

- [ ] **Step 1: Write `lib/auth/session.test.ts` (failing)**

Cases: a `viewer` resolves to `ROLE_BUNDLES.viewer` and issues **no** query against `user_permission_grants`; a `custom` user resolves to their rows; a `custom` user with zero rows resolves to `{}` and `can()` is false for every capability; no session → `null`.

- [ ] **Step 2: Run and confirm failure**

- [ ] **Step 3: Implement session, guard, barrel; delete `lib/auth.ts`**

`requirePermission` keeps the exact `requireRole` contract: throws `new Response("Unauthorized", {status:401})` with no session, `new Response("Forbidden", {status:403})` when the check fails. `index.ts` must re-export `getSessionUser`, `UserRole`, `requirePermission`, `can`, `CAP`, `ROLE_BUNDLES` so `@/lib/auth` keeps resolving.

- [ ] **Step 4: Update `/api/auth/me` to return the resolved grant map**

Response shape becomes `{ user, role, grants }`. `grants` is already resolved server-side so the client cannot drift.

- [ ] **Step 5: Add `usePermissions` to `lib/hooks/useUserRole.ts`**

Wraps the existing `useAuthMeQuery` and calls the **same** `can` from `lib/auth/resolve.ts`. Keep `useUserRole` exported — task 10 removes its call sites.

- [ ] **Step 6: Run `npm run verify`** → PASS

- [ ] **Step 7: Commit**

---

## Task 5: Equivalence fixture + test

**Files:**
- Create: `lib/auth/__fixtures__/legacy-matrix.ts`, `lib/auth/__tests__/equivalence.test.ts`

**Interfaces:**
- Consumes: `ROLE_BUNDLES`, `CAP`, `can`.
- Produces: `LEGACY_MATRIX: LegacyRow[]` where
```ts
interface LegacyRow {
  route: string; method: string; legacy: UserRole[]; capability: keyof typeof CAP;
  intentionalChange?: Partial<Record<UserRole, boolean>> & { reason: string };
}
```

**Generate, don't hand-type.** The 211 rows come from `docs/superpowers/specs/2026-07-25-scoped-permissions-validation/` — `audit94.txt` supplies route/method/legacy, and `verify.mjs`'s `scopeFor` + `GROUP_LEVEL` + `ROUTE_OVERRIDE` supply scope and level. Map each (scope, level) to its `CAP` name.

The 28 rows carrying `intentionalChange` are enumerated in the spec's Validation result table. Each needs its `reason` string.

- [ ] **Step 1: Generate the fixture**
- [ ] **Step 2: Write the equivalence test**

```ts
for (const row of LEGACY_MATRIX)
  for (const role of ["viewer","brewer","manager","admin"] as const)
    expect(can(ROLE_BUNDLES[role], CAP[row.capability].scope, CAP[row.capability].level))
      .toBe(row.intentionalChange?.[role] ?? legacyRequireRole(role, row.legacy));
```
where `legacyRequireRole(role, list) = role === "admin" || list.includes(role)`.

- [ ] **Step 3: Run** → PASS, 844 assertions.

**Acceptance criteria:** exactly 211 rows; exactly 28 carry `intentionalChange`; every `reason` is non-empty.

- [ ] **Step 4: Commit**

---

## Tasks 6–8: Route conversion

Same shape for all three. **Task 6** = `app/api/production/**` (82 sites / 63 files). **Task 7** = `app/api/finance/**` + `app/api/payroll/**` (67 sites). **Task 8** = `app/api/{tax,brand,admin,settings,taproom}/**` plus top-level `targets`, `manual-entries`, `partners` (62 sites).

**Per-file transform:**

```ts
- import { requireRole } from "@/lib/auth";
+ import { requirePermission, CAP } from "@/lib/auth";
- try { await requireRole(["brewer"]); } catch (res) { return res as Response; }
+ try { await requirePermission(CAP.brewingOperate); } catch (res) { return res as Response; }
```

**The capability for each route is fixed by the spec appendix — do not infer it.** The appendix is grouped by scope and lists every route with its method, legacy argument, and assigned level. Scope does **not** always follow the directory; three routes deliberately contradict it (`taproom-consumption/*`, `recipe-square-link*`, `packaging-variations`) and are called out in the spec's assignment-policy table.

- [ ] **Step 1: Convert every call site in the group**
- [ ] **Step 2: Run the equivalence test** → `npx vitest run lib/auth/__tests__/equivalence.test.ts` → PASS
- [ ] **Step 3: Run `npm run verify`** → PASS
- [ ] **Step 4: Confirm no `requireRole` remains in the group**

Run: `grep -rn "requireRole" app/api/<group>/ | grep -v "^.*://"`
Expected: no output.

- [ ] **Step 5: Commit**

**Acceptance criteria:** zero `requireRole` references in the group; equivalence test green; no route's capability invented rather than read from the appendix.

---

## Task 9: Layouts + nav configs

**Files:**
- Modify: `app/{finance,brand,production}/layout.tsx`, `app/taproom/{settings,payroll}/layout.tsx`, `app/settings/layout.tsx`
- Modify: `app/brand/{guide,releases}/page.tsx`, `app/settings/{business,users,requests,appearance,cron}/page.tsx`, `app/production/brewing/calendar/page.tsx`
- Modify: `app/{finance,taproom,production}/nav-config.ts`, `app/brand/nav-config.ts`
- Modify: `app/components/NavBar.tsx`, `app/components/SubNav.tsx`, `app/settings/SettingsTabs.tsx`

**Interfaces:**
- `NavEntry.adminOnly` / `.managerOnly` are **replaced** by `requires?: Capability`. Remove the old fields entirely — leaving them creates exactly the two-vocabularies problem this project exists to end.

Server layouts use `can(session.grants, cap.scope, cap.level)`; client nav uses `usePermissions()`. `NavBar.tsx` currently hardcodes `isAdmin` and `canAccessProduction` inline (around line 92) — both become capability checks driven by the nav config, not local booleans.

- [ ] **Step 1: Add `requires` to `NavEntry`, remove `adminOnly`/`managerOnly`**
- [ ] **Step 2: Update the four nav configs**
- [ ] **Step 3: Update `SubNav`, `NavBar`, `SettingsTabs` to filter on `usePermissions()`**
- [ ] **Step 4: Update the six layouts and six pages**
- [ ] **Step 5: Run `npm run verify`** → PASS
- [ ] **Step 6: Manual check** — sign in as each of viewer/brewer/manager/admin, confirm the visible nav matches the pre-change nav exactly.
- [ ] **Step 7: Commit**

**Acceptance criteria:** no `role === "` or `role !== "` remains in any file touched by this task; nav for the four existing roles is visually unchanged.

---

## Task 10: UI inline role checks

**Files:** the 24 files containing inline role comparisons — notably `app/production/components/{BatchLogTab,PackagingTab,IngredientsTab,BrewStatusTab}.tsx` and `app/taproom/components/{TargetSettingTab,ManualEntriesTab}.tsx`.

**Transform:** `const isAdmin = role === "admin"` → `const { can } = usePermissions()`, then gate each control on the capability its API call requires — the **same** `CAP` entry the route uses.

**The user-visible change lands here.** Per spec decision 5, the **Del** button in `IngredientsTab.tsx:710` and `PackagingTab.tsx:316` must move behind `CAP.ingredientMasterEdit` / `CAP.packagingMasterEdit`, the same capability as Edit. It is currently visible to brewers. If only the API is tightened, brewers keep a button that 403s.

- [ ] **Step 1: Convert all 24 files**
- [ ] **Step 2: Verify Del and Edit share a capability in both inventory tabs**
- [ ] **Step 3: Run `npm run verify`** → PASS
- [ ] **Step 4: Commit**

**Acceptance criteria:** zero `role === "` / `role !== "` outside `lib/auth/`; every gated control references a `CAP` entry, never a literal `{scope, level}`.

---

## Task 11: Admin UI — grants matrix

**Files:**
- Create: `app/api/admin/users/[id]/grants/route.ts`, `app/settings/users/GrantMatrix.tsx`
- Modify: `app/settings/users/UserManagement.tsx`

**Interfaces:**
- `GET`/`PUT /api/admin/users/[id]/grants` — `PUT` body `{ grants: Record<string, Level> }`, guarded by `requirePermission(CAP.usersManage)`, admin (service_role) client.

`UserManagement.tsx:11` declares a local `type UserRole` duplicating `lib/auth`'s — delete it and import instead, so `custom` propagates automatically. `ROLES` (line 21) and `ROLE_COLORS` (line 23) become five-entry.

`GrantMatrix` renders seven collapsed section rows, each a `none/read/operate/manage/admin` select, expandable to that section's leaves. Rendered only when the selected role is `custom`.

- [ ] **Step 1: Write the grants route**
- [ ] **Step 2: Build `GrantMatrix`** — `<Modal>`/`<Field>`/`.inp` primitives, token colors only
- [ ] **Step 3: Wire into `UserManagement`, replacing the local `UserRole`**
- [ ] **Step 4: Invalidate `queryKeys.auth.all()` on save**

`useUserRole` uses `staleTime: Infinity`; without invalidation an admin's grant edit will not reach the user until they reload.

- [ ] **Step 5: Run `npm run verify`** → PASS
- [ ] **Step 6: Commit**

---

## Task 12: CI guards + delete `requireRole`

**Files:**
- Modify: `lib/auth/index.ts` (remove `requireRole`), `package.json` or the existing guard script
- Create: the four guard checks

| Guard | Check |
|---|---|
| no `requireRole(` outside `lib/auth/` | grep, non-zero exit on hit |
| no `role === "` / `role !== "` outside `lib/auth/` | grep, non-zero exit on hit |
| every `CAP` entry referenced ≥ 1× | script |
| every `ScopeKey` used by ≥ 1 capability | script |

**`taproom.settings` is the known exception to the last guard** — it has no API routes and is enforced only by `app/taproom/settings/layout.tsx`. Capabilities referenced solely by a layout or nav config must count as used, or the guard false-positives.

- [ ] **Step 1: Delete `requireRole`**
- [ ] **Step 2: Add the four guards to the existing CI guard script**
- [ ] **Step 3: Run the guards** → all pass
- [ ] **Step 4: Run `npm run verify`** → PASS
- [ ] **Step 5: Commit**

---

## Task 13: Final whole-branch review

Opus, once, over the full diff. Focus:
- Every route's capability matches the spec appendix (spot-check ≥ 20 across all three conversion tasks).
- No capability was invented to make a test pass.
- The 28 intentional changes in the fixture match the spec's Validation result table exactly.
- Del/Edit share a capability in both inventory tabs.
- No RLS policy was modified beyond the new `user_permission_grants` select policy.

**Do not skip this review under budget pressure** — the final whole-branch pass has caught real bugs on this repo before.

---

## Rollout (orchestrator, after task 13)

1. Back up prod.
2. Apply `20260726` then `20260727` — in that order, separate transactions.
3. Confirm `select unnest(enum_range(null::user_role))` includes `custom`.
4. Heads-up to the brewing team: brewers lose the Del button on Ingredients and Packaging.
5. Set one test user to `custom`, grant `finance@read`, confirm they see Finance read-only and nothing else.
