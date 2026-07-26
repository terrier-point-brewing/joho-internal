# Scoped Permissions — Design

**Date:** 2026-07-25
**Branch:** `claude/scoped-permissions`
**Baseline:** `94e2114` (main)
**Status:** Approved design, pending implementation plan

---

## Goal

Let an admin grant an individual user access to specific parts of the app at a
specific level — "this viewer can see Finance", "this viewer can edit Brand" —
without weakening or reshuffling the four existing roles.

Delivered by adding a fifth role, `custom`. When a user's role is `custom`,
their access comes from per-user scope+level grants instead of a role bundle.
The four existing roles keep their exact current behavior, proven mechanically
(see [Equivalence test](#equivalence-test)).

---

## Why this needs more than a section-level flag

An audit of every permission check in the app — 211 `requireRole` call sites
across `app/api/**`, plus 33 inline `role === "…"` comparisons in 24 UI files —
found that meaningful permission rules already exist *below* section level, and
that they are currently expressed only as scattered literals.

| Section | Sub-rule baked into roles today |
|---|---|
| Taproom | Managers run everything **except** Targets and Manual Entries, which are admin-only |
| Finance | `transactions` GET allows viewer; `financials` / `pl` / `cogs` GET are admin-only. Same section, two read tiers |
| Tax | reads = manager, writes = admin, PII `reveal` endpoints = admin. Three tiers in one section |
| Production | brewer does the work, but `equipment`, `floorplan-settings`, `safety-stock`, `batches DELETE` and `tank-assignments PATCH` are admin |
| Payroll | `periods` GET = manager, but `config` and `employees` GET = admin |

Two structural facts follow:

1. **The hidden axis is a sensitivity ladder, not more sections.** The same
   shape recurs everywhere: read routine data → do the day's work → change the
   rules → destructive/confidential. `brewer` and `manager` occupy the same rung
   in different domains, which is exactly why `lib/auth.ts` had to document them
   as "scoped siblings, not a hierarchy".

2. **Sensitivity does not track HTTP method.** `finance/financials` GET,
   `tax/bank-account/reveal` GET and `payroll/employees` GET are all admin-only
   *reads*. Any method-based shortcut for assigning levels is wrong.

### UI/API divergence

Three places gate the same action in two layers, with two different vocabularies,
and disagree:

| Divergence | Today |
|---|---|
| 8 finance routes accept `viewer`; `app/finance/layout.tsx` redirects every non-admin | API more permissive than UI; no viewer has ever reached them |
| `IngredientsTab.tsx:707` hides **Edit** behind `isAdmin`; API accepts `brewer` | UI stricter than API |
| `PackagingTab.tsx:313` — same shape | UI stricter than API |

The root cause is that the two layers speak different languages: JSX says
`role === "admin"`, the route says `requireRole(["brewer"])`. Nothing forces
them to agree. The design fixes this structurally via
[named capabilities](#capabilities), not by convention.

---

## Decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | **Roles become bundles of grants.** A static table maps each role → `{scope: level}`. `custom` is a role with an empty bundle plus per-user rows | One resolver, one code path. The permission matrix becomes readable in one file instead of 244 scattered expressions |
| 2 | **Four-rung ladder:** `read < operate < manage < admin` | Matches the shape the audit found. Expresses "manager may view Targets but not edit them" as a level difference, with no extra scope |
| 3 | **Hierarchical scopes, longest-prefix override** | `finance` cascades to `finance.*`; `finance.statements` overrides it. Common case is one dropdown, fine control is one expand away |
| 4 | **Convert all 211 call sites; delete `requireRole`** | Guarded by the equivalence test, so behavior change fails CI. Avoids a permanent half-migrated state |
| 5 | **Master data is admin-only to edit *or* delete.** Brewers may create and adjust, nothing else | `ingredients`/`packaging` PATCH **and** DELETE move to `manage`. PATCH matches button visibility that already existed; DELETE is a deliberate tightening — see [user-visible change](#the-one-user-visible-change) |
| 6 | **Manager has no Finance access at all** | Manager's six `finance.transactions` routes are dead code: every caller lives in `app/finance/transactions/expenses/*`, behind the admin-only Finance layout. The Taproom payroll UI that managers *can* reach fetches only `/api/payroll/periods` |

Two concepts considered and dropped: a `base_role` column (unnecessary once
scopes are hierarchical — a "viewer baseline" is just a `taproom@read` grant),
and grants that apply to non-custom roles (grants are consulted **only** when
`role === "custom"`, matching the mental model of "pick Custom, then choose").

---

## Core model

### Levels

```ts
// lib/auth/levels.ts
export type Level = "none" | "read" | "operate" | "manage" | "admin";
export const RANK: Record<Level, number> = { none: 0, read: 1, operate: 2, manage: 3, admin: 4 };
```

Ordered — each level implies every level below it.

**`none` was added during implementation, not in the original design, and it is
load-bearing.** Without it, hierarchical grants can only ever widen: setting a
leaf to "None" in the admin UI merely omits the key, so longest-prefix falls
back to the ancestor and nothing is revoked. That silently broke this design's
headline workflow — "grant Finance but not the P&L". As an explicit stored
level at rank 0, `none` wins the longest-prefix match and denies. Note the
three distinct leaf states this creates: absent (inherit), an explicit level,
and explicit `none` (revoked). `ROLE_BUNDLES` never contains `none`; a test
asserts that.

### Scopes

Twenty leaves across seven prefixes. A scope is split only where two resources
genuinely need **different read levels**; the ladder absorbs everything else.

```
taproom.performance    taproom.targets       taproom.settings
production.brewing     production.inventory  production.export     production.recipes
production.partners    production.equipment  production.settings
finance.transactions   finance.statements
payroll
tax                    tax.pii
brand.guide            brand.workbench
settings.business      settings.users        settings.cron
```

Two leaves exist purely to encode rules that are invisible today:
`taproom.targets` (Targets edits are admin while the rest of Taproom is manager)
and `tax.pii` (the `reveal` endpoints are a different *resource*, not a higher
action on the same one).

**`taproom.settings` has no API routes of its own.** It is enforced only by the
`app/taproom/settings/layout.tsx` redirect — the Square Item Mappings page it
hosts calls `production/recipe-square-link*`, which belongs to
`production.settings`. Its capability is therefore layout-only, which the
"every `ScopeKey` used by ≥ 1 capability" CI guard must accept: capabilities
referenced solely by a layout or nav config count as used. This is the one scope
where the guard would otherwise produce a false positive.

```ts
// lib/auth/scopes.ts
export const SCOPES = {
  "taproom.performance": { label: "Performance", section: "taproom" },
  "taproom.targets":     { label: "Targets",     section: "taproom" },
  // …20 leaves
} as const;
export type ScopeKey = keyof typeof SCOPES;
export type Section  = "taproom" | "production" | "finance" | "payroll" | "tax" | "brand" | "settings";
export const ROOT = "" as const;
```

`ScopeKey` is derived from the const, so a typo is a compile error rather than a
runtime 403.

### Grant maps

One shape, used by both role bundles and user grants:

```ts
export type ScopeGrants = Partial<Record<ScopeKey | Section | typeof ROOT, Level>>;
```

### Role bundles

The entire permission matrix, in one file:

```ts
// lib/auth/roleGrants.ts
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

  custom: {},   // grants come from user_permission_grants
};
```

`manager: { taproom: "operate", "taproom.targets": "read" }` is the Targets
rule, written down for the first time. `admin: { [ROOT]: "admin" }` replaces the
implicit-admin special case in today's `requireRole` — admin is just the
shortest-prefix grant, so the special case disappears into data.

### Resolver

```ts
// lib/auth/resolve.ts — pure, no I/O
export function effectiveLevel(grants: ScopeGrants, scope: ScopeKey): Level | null;
export function can(grants: ScopeGrants, scope: ScopeKey, need: Level): boolean;
```

`effectiveLevel` is longest-prefix-wins: a key matches when it is `ROOT`, equals
the scope, or is a dot-prefix of it; the longest matching key supplies the level.

### Session

Resolution happens once, at load, and nothing downstream knows which source the
grants came from:

```ts
// lib/auth/session.ts
export interface Session { user: User; role: UserRole; grants: ScopeGrants }
// grants = role === "custom" ? rows from user_permission_grants : ROLE_BUNDLES[role]
```

### Schema

Two migration files — `ALTER TYPE … ADD VALUE` cannot be *used* in the
transaction that adds it, and Supabase runs each migration file in one
transaction. Distinct date prefixes, because the CLI keys on the digits before
the first `_` and same-day prefixes collide.

```sql
-- supabase/migrations/20260819_user_role_custom.sql
alter type user_role add value 'custom';
```

```sql
-- supabase/migrations/20260820_user_permission_grants.sql
create type permission_level as enum ('read','operate','manage','admin');

create table user_permission_grants (
  user_id    uuid not null references profiles(id) on delete cascade,
  scope      text not null,
  level      permission_level not null,
  granted_by uuid references profiles(id),
  granted_at timestamptz not null default now(),
  primary key (user_id, scope)
);

alter table user_permission_grants enable row level security;

-- getSessionUser reads through the SERVER client. Without this policy every
-- custom user silently resolves to zero permissions.
create policy "users read own grants" on user_permission_grants
  for select to authenticated using (user_id = auth.uid());
-- writes are service_role only (admin client), no authenticated write policy
```

**No RLS policy changes elsewhere.** The broad phase-1 policies grant
`to authenticated using (true)` — keyed on the Postgres grantee role, not
`get_my_role()` — so a `custom` user keeps normal operational-table access. The
two tier-restricted helpers (`finance_reader_roles()` = empty,
`payroll_reader_roles()` = manager/admin) do not match `'custom'` and so
fail closed, which is correct and inconsequential: finance routes are 30/33
admin-client and brand routes are 7/7 admin-client, so the API layer is the gate
for both.

### File layout

`lib/auth.ts` becomes `lib/auth/index.ts` re-exporting the same names, so the
~200 existing `@/lib/auth` imports do not move.

```
lib/auth/
  index.ts          barrel — preserves the @/lib/auth import path
  levels.ts         Level, RANK
  scopes.ts         SCOPES, ScopeKey, Section, ROOT
  roleGrants.ts     ROLE_BUNDLES
  capabilities.ts   CAP — the permission manifest
  resolve.ts        effectiveLevel, can          (pure)
  session.ts        getSessionUser               (I/O)
  guard.ts          requirePermission            (throws Response)
  + co-located *.test.ts for each
```

---

## Capabilities

Named intents, imported by **both** the route and the component that gates the
same action. This is what makes UI/API divergence structurally impossible: there
is only one thing to gate on.

```ts
// lib/auth/capabilities.ts
export const CAP = {
  ingredientMasterEdit:  { scope: "production.inventory", level: "manage"  },
  ingredientStockAdjust: { scope: "production.inventory", level: "operate" },
  batchDelete:           { scope: "production.brewing",   level: "admin"   },
  targetsEdit:           { scope: "taproom.targets",      level: "manage"  },
  taxPiiReveal:          { scope: "tax.pii",              level: "admin"   },
  // …~45 named intents; several may share a (scope, level) pair
} as const;
```

Route: `await requirePermission(CAP.batchDelete)`
Component: `can(grants, CAP.batchDelete)`

Capabilities name the *intent*, so the call site stays readable even when
several map to the same coordinates. The file doubles as the permission
manifest — one place to read every gated action in the app and what it takes to
perform it.

---

## Enforcement layers

All four delegate to the same resolver. No layer carries its own logic.

| Layer | Before | After |
|---|---|---|
| API route | `await requireRole(["brewer"])` | `await requirePermission(CAP.brewingOperate)` |
| Server layout/page | `if (session.role !== "admin") redirect("/")` | `if (!can(session.grants, CAP.brandGuideRead)) redirect("/")` |
| Nav config | `adminOnly` / `managerOnly` | `requires: CAP.<name>` |
| Client component | `const isAdmin = role === "admin"` | `const { can } = usePermissions()` |

```ts
// lib/auth/guard.ts
export async function requirePermission(cap: Capability): Promise<Session>;
// throws Response 401 (no session) / 403 (insufficient) — same contract as requireRole
```

`usePermissions()` wraps the existing `useAuthMeQuery` and runs the *same*
`resolve.ts` function, so the client cannot drift from the server.
`/api/auth/me` returns the already-resolved grant map.

Two constraints:

- **Client `can()` governs affordance only.** The server remains the gate.
- **`useUserRole` uses `staleTime: Infinity`.** Grant mutations must invalidate
  `queryKeys.auth.all()`, or an admin's edit will not land until the affected
  user reloads.

### Assignment policy

Level comes from the nature of the operation, never the HTTP method:

| Level | Test | Examples |
|---|---|---|
| `read` | returns data for display | list batches, view a tax task |
| `operate` | writes a transactional record that is part of the day's work | log a brew activity, adjust stock, ship an allocation, run a tap swap |
| `manage` | changes configuration or master data that operations run against | export settings, Square mappings, chart of accounts, ingredient master record, **targets** |
| `admin` | destructive, confidential, or org-governing | delete a batch, reveal bank/SSN, publish canon, edit users, cron |

Scope comes from the **resource touched, not the URL path**. Three routes prove
the distinction and are assigned against their directory:

| Route | Directory suggests | Actual scope | Why |
|---|---|---|---|
| `production/taproom-consumption/{phantom-alerts,dismiss-phantom,reconcile-phantom}` | production | `taproom.performance` | Taproom draft reconciliation, manager-gated |
| `production/recipe-square-link{,-ignores}` | production.recipes | `production.settings` | It *is* the Square Item Mappings settings page; also shared with Taproom inventory |
| `production/taproom-consumption/sync` | taproom | `production.brewing` | Brewer-side job that writes the production ledger |
| `production/packaging-variations` | production.inventory | `production.recipes` | Despite the `packaging` prefix, this is the **Packaging Variations** page at `/production/recipes/variations` — recipe configuration, not stock. A naive `^production/packaging` rule captures it wrongly |

---

## Equivalence test

The audit is committed as a fixture and becomes the migration's safety net.

```ts
// lib/auth/__fixtures__/legacy-matrix.ts — 211 rows, generated from the audit
{ route: "api/production/batches/[id]", method: "DELETE",
  legacy: [], capability: "batchDelete" }

// intentional changes are declared inline, never silent:
{ route: "api/production/ingredients/[id]", method: "PATCH",
  legacy: ["brewer"], capability: "ingredientMasterEdit",
  intentionalChange: { brewer: false,
    reason: "UI always hid Edit from brewer; the API was the outlier" } }
```

```ts
// lib/auth/__tests__/equivalence.test.ts
for (const row of LEGACY_MATRIX)
  for (const role of ["viewer", "brewer", "manager", "admin"] as const)
    expect(can(ROLE_BUNDLES[role], CAP[row.capability]))
      .toBe(row.intentionalChange?.[role] ?? legacyRequireRole(role, row.legacy));
```

844 assertions. Any conversion that changes an existing role's access fails CI
unless someone wrote down why.

**This test has a blind spot, and a second test closes it.** It only asks
whether each of the four legacy roles gets the same allow/deny answer as
before. A capability given the wrong scope or level is therefore invisible
whenever the wrong coordinate happens to produce identical answers for all
four. A sweep over the implemented branch found 31 of 37 levels and 35 of 37
scopes could be changed with this suite still green — including downgrading
`taxPiiReveal` from `admin` to `manage`. That is precisely the surface a
`custom` user's grants resolve against. `lib/auth/__tests__/capability-coordinates.test.ts`
pins every capability's exact `(scope, level)` against a committed table, so a
coordinate change fails CI on its own terms rather than only when a legacy role
happens to notice.

### Validation result

The bundle table and level assignments above were run against all 211 routes
before this spec was written:

```
211 routes × 4 roles = 844 assertions
identical: 816    differing: 28
```

All 28 differences are accounted for. There are no unexplained deltas.

| Change | n | Justification |
|---|---|---|
| `viewer` LOSES `finance.transactions@read` | 8 | API-only; `app/finance/layout.tsx` already redirects every non-admin |
| `viewer` LOSES `production.{export,settings,partners,brewing}@read` | 8 | API-only; `app/production/layout.tsx` already redirects viewers |
| `manager` LOSES `finance.transactions@manage` | 6 | Decision 6. Dead code — every caller is under `app/finance/transactions/expenses/*`, behind the admin-only Finance layout |
| `brewer` GAINS `production.brewing@read` | 1 | `batch-conversions`: brewer could POST but not GET — an artifact of `["viewer"]` not meaning "viewer and above" |
| `brewer` GAINS `production.settings@operate` | 1 | `packaging-fee-class`: brewer manages every other export setting; this one was arbitrarily manager-only. Reviewed and accepted |
| `brewer` LOSES `production.inventory@manage` | 4 | `ingredients`/`packaging` PATCH **and** DELETE — decision 5 |

Of the 28, 24 are provably unreachable today (16 viewer + 6 manager, all behind
layouts that already redirect those roles; plus the 2 brewer gains, which grant
rather than remove).

### User-visible changes

Two changes a real user will notice. First, `ingredients`/`packaging`
**DELETE** moving to `manage`. The Del button in `IngredientsTab.tsx:710` and
`PackagingTab.tsx:316` is visible to brewers today and is used; after this
change it disappears for them, leaving Adjust (and Create) as their inventory
actions.

This is deliberate per decision 5 — a role that may not *edit* a master record
should not be able to *delete* it, and the previous split was incoherent. But it
removes a capability brewers currently exercise, so it warrants a heads-up to
the brewing team at rollout rather than shipping silently.

Implementation note: both components must have their Del button moved behind the
same capability as Edit. If only the API is tightened, brewers keep a button
that 403s.

Second, brewers lose the floorplan **edit-layout** affordance in
`BrewStatusTab.tsx`. Its gate was `role === "brewer" || role === "admin"`, but
the routes behind it (`production/equipment`, `production/floorplan-settings`)
were already admin-only, so a brewer's drag-and-drop always 403'd. The gate now
reads `production.equipment@manage`, which brewers do not have, so the control
is hidden rather than broken. No working capability is removed — but the button
does disappear, so it belongs in the rollout note alongside Del.

---

## CI guards

Following the blocking-guard pattern the repo already uses for the
search/filter standard:

| Guard | Prevents |
|---|---|
| no `requireRole(` outside `lib/auth/` | the old idiom creeping back |
| no `role === "` / `role !== "` outside `lib/auth/` | gating that bypasses the resolver |
| every `CAP` entry referenced ≥ 1× | dead permissions accumulating |
| every `ScopeKey` used by ≥ 1 capability | the taxonomy rotting away from reality |

The last two are what keep the manifest honest a year from now.

---

## Admin UI

`app/settings/users/UserManagement.tsx` already centralizes roles in a `ROLES`
array and a `ROLE_COLORS` map; both become five-entry. Selecting **Custom**
reveals a grant matrix: seven collapsed section rows, each with a
`none / read / operate / manage / admin` dropdown, expandable to the leaves
underneath. Because scopes are hierarchical, "let this viewer see Finance" is
one dropdown and "…but not the P&L" is one expand away.

Grants save through `PUT /api/admin/users/[id]/grants` (admin client,
`requirePermission(CAP.usersManage)`), which invalidates `queryKeys.auth.all()`.

---

## Testing

- Co-located `*.test.ts` for every new `lib/auth/*` module, per repo rules.
- `resolve.ts` covered exhaustively — prefix precedence, ordering, ROOT grant,
  empty bundle, unknown scope — since every other layer delegates to it.
- The equivalence test above.
- A shape test asserting every scope named in `ROLE_BUNDLES` and `CAP` exists in
  `SCOPES`.
- `npm run verify` is the definition of done.

---

## Rollout

Migrations are additive. No RLS policy changes. `custom` is opt-in per user, so
the blast radius on day one is zero users. Two changes are user-visible — see
[User-visible changes](#user-visible-changes) — and both remove affordances
that already failed server-side, so no working capability is lost.

**Scale:** ~200 files — roughly 160 route files, 11 nav/layout files, 24 files
with inline role checks, ~10 new `lib/auth` modules, 2 migrations, 4 admin-UI
files. Subagent-driven-development tier per `CLAUDE.md`, decomposed by locality
group (one agent per section's routes, since a section's routes share
capabilities).

---

## Appendix — route → capability decision table

211 rows, grouped by scope. `Legacy` is the current `requireRole` argument;
`Level` is the assigned rung. This table is the input to
`lib/auth/__fixtures__/legacy-matrix.ts`; the equivalence test is the arbiter of
any row that turns out to be wrong.

#### `brand.guide` — 5 routes

| Method | Route | Legacy | Level |
|---|---|---|---|
| GET | `brand/canon/draft` | `[]` | `manage` |
| PUT | `brand/canon/draft` | `[]` | `manage` |
| POST | `brand/canon/publish` | `[]` | `manage` |
| GET | `brand/canon/versions` | `[]` | `manage` |
| PUT | `brand/chrome` | `[]` | `manage` |

#### `brand.workbench` — 7 routes

| Method | Route | Legacy | Level |
|---|---|---|---|
| GET | `brand/assets` | `[]` | `read` |
| POST | `brand/assets` | `[]` | `manage` |
| PATCH | `brand/assets/[id]` | `[]` | `manage` |
| GET | `brand/labels` | `[]` | `read` |
| POST | `brand/labels` | `[]` | `manage` |
| GET | `brand/labels/[id]` | `[]` | `read` |
| PATCH | `brand/labels/[id]` | `[]` | `manage` |

#### `finance.statements` — 4 routes

| Method | Route | Legacy | Level |
|---|---|---|---|
| GET | `finance/cogs` | `[]` | `read` |
| GET | `finance/financials` | `[]` | `read` |
| GET | `finance/pl` | `[]` | `read` |
| GET | `finance/taxes` | `[]` | `read` |

#### `finance.transactions` — 42 routes

| Method | Route | Legacy | Level |
|---|---|---|---|
| GET | `finance/account-mappings` | `[viewer]` | `read` |
| PATCH | `finance/account-mappings` | `[]` | `manage` |
| POST | `finance/account-mappings/bulk` | `[]` | `manage` |
| GET | `finance/bank-ledger` | `[viewer]` | `read` |
| PATCH | `finance/bank-ledger` | `[]` | `manage` |
| GET | `finance/catalog-with-categories` | `[viewer]` | `read` |
| DELETE | `finance/chart-of-accounts` | `[]` | `manage` |
| GET | `finance/chart-of-accounts` | `[viewer]` | `read` |
| PATCH | `finance/chart-of-accounts` | `[]` | `manage` |
| POST | `finance/chart-of-accounts` | `[]` | `manage` |
| GET | `finance/expense-counterparty-mappings` | `[viewer]` | `read` |
| PATCH | `finance/expense-counterparty-mappings` | `[]` | `manage` |
| GET | `finance/expense-mappings` | `[viewer]` | `read` |
| PATCH | `finance/expense-mappings` | `[]` | `manage` |
| GET | `finance/expenses` | `[viewer]` | `read` |
| PATCH | `finance/expenses` | `[]` | `manage` |
| DELETE | `finance/expenses/[id]/exclude` | `[manager]` | `manage` |
| POST | `finance/expenses/[id]/exclude` | `[manager]` | `manage` |
| POST | `finance/expenses/[id]/payroll-match` | `[manager]` | `manage` |
| DELETE | `finance/expenses/[id]/splits` | `[manager]` | `manage` |
| PUT | `finance/expenses/[id]/splits` | `[manager]` | `manage` |
| POST | `finance/expenses/auto-map` | `[]` | `manage` |
| POST | `finance/expenses/auto-map-payroll` | `[manager]` | `manage` |
| POST | `finance/expenses/sync` | `[]` | `manage` |
| POST | `finance/import/parse-pdf` | `[]` | `manage` |
| GET | `finance/ledger/invoice-batch-links` | `[]` | `manage` |
| POST | `finance/ledger/invoice-batch-links` | `[]` | `manage` |
| DELETE | `finance/ledger/invoice-batch-links/[id]` | `[]` | `manage` |
| PATCH | `finance/ledger/invoice-line-items` | `[]` | `manage` |
| GET | `finance/ledger/invoices` | `[]` | `manage` |
| PATCH | `finance/ledger/invoices` | `[]` | `manage` |
| POST | `finance/ledger/invoices` | `[]` | `manage` |
| POST | `finance/ledger/invoices/auto-map` | `[]` | `manage` |
| POST | `finance/ledger/sync-square` | `[]` | `manage` |
| GET | `finance/ramp/statements` | `[]` | `manage` |
| GET | `finance/ramp/transactions` | `[]` | `manage` |
| POST | `finance/sync-catalog` | `[]` | `manage` |
| GET | `finance/transactions` | `[viewer]` | `read` |
| PATCH | `finance/transactions` | `[]` | `manage` |
| POST | `finance/transactions/auto-map` | `[]` | `manage` |
| PATCH | `finance/transactions/line-items` | `[]` | `manage` |
| POST | `finance/transactions/sync` | `[]` | `manage` |

#### `payroll` — 18 routes

| Method | Route | Legacy | Level |
|---|---|---|---|
| POST | `finance/payroll-periods/[periodId]/recompute-splits` | `[manager]` | `operate` |
| GET | `finance/settings/payroll-department-mappings` | `[manager]` | `read` |
| PUT | `finance/settings/payroll-department-mappings` | `[manager]` | `operate` |
| GET | `payroll/config` | `[]` | `manage` |
| PATCH | `payroll/config` | `[]` | `manage` |
| GET | `payroll/employees` | `[]` | `manage` |
| POST | `payroll/employees` | `[]` | `manage` |
| PATCH | `payroll/employees/[id]` | `[]` | `manage` |
| POST | `payroll/employees/sync-square` | `[]` | `manage` |
| GET | `payroll/periods` | `[manager]` | `read` |
| POST | `payroll/periods` | `[]` | `manage` |
| GET | `payroll/periods/[id]` | `[manager]` | `read` |
| PATCH | `payroll/periods/[id]/entries/[employeeId]` | `[]` | `manage` |
| GET | `payroll/periods/[id]/gusto-report` | `[manager]` | `read` |
| POST | `payroll/periods/[id]/gusto-report` | `[manager]` | `operate` |
| POST | `payroll/periods/[id]/lock` | `[]` | `manage` |
| GET | `payroll/periods/[id]/preview` | `[manager]` | `read` |
| GET | `payroll/periods/[id]/shifts` | `[]` | `manage` |

#### `production.brewing` — 17 routes

| Method | Route | Legacy | Level |
|---|---|---|---|
| GET | `production/batch-conversions` | `[viewer]` | `read` |
| POST | `production/batch-conversions` | `[brewer]` | `operate` |
| POST | `production/batch-schedule` | `[brewer]` | `operate` |
| DELETE | `production/batch-schedule/[id]` | `[brewer]` | `operate` |
| PATCH | `production/batch-schedule/[id]` | `[brewer]` | `operate` |
| POST | `production/batch-scheduler/suggest` | `[brewer]` | `operate` |
| POST | `production/batches` | `[brewer]` | `operate` |
| DELETE | `production/batches/[id]` | `[]` | `admin` |
| PATCH | `production/batches/[id]` | `[brewer]` | `operate` |
| DELETE | `production/brew-activities` | `[brewer]` | `operate` |
| PATCH | `production/brew-activities` | `[brewer]` | `operate` |
| POST | `production/brew-activities` | `[brewer]` | `operate` |
| PATCH | `production/tank-assignments` | `[]` | `admin` |
| POST | `production/tank-assignments` | `[brewer]` | `operate` |
| PATCH | `production/tank-assignments/[id]` | `[brewer]` | `operate` |
| POST | `production/taproom-consumption/sync` | `[brewer]` | `operate` |
| POST | `production/transfers` | `[brewer]` | `operate` |

#### `production.equipment` — 4 routes

| Method | Route | Legacy | Level |
|---|---|---|---|
| POST | `production/equipment` | `[]` | `manage` |
| DELETE | `production/equipment/[id]` | `[]` | `manage` |
| PATCH | `production/equipment/[id]` | `[]` | `manage` |
| PUT | `production/floorplan-settings` | `[]` | `manage` |

#### `production.export` — 21 routes

| Method | Route | Legacy | Level |
|---|---|---|---|
| GET | `production/allocations` | `[viewer, brewer, manager]` | `read` |
| POST | `production/allocations` | `[brewer]` | `operate` |
| DELETE | `production/allocations/[id]` | `[brewer]` | `operate` |
| PATCH | `production/allocations/[id]` | `[brewer]` | `operate` |
| POST | `production/allocations/[id]/adjust` | `[brewer]` | `operate` |
| GET | `production/allocations/[id]/invoice` | `[brewer]` | `operate` |
| POST | `production/allocations/[id]/invoice` | `[brewer]` | `operate` |
| DELETE | `production/allocations/[id]/write-off` | `[brewer]` | `operate` |
| POST | `production/allocations/[id]/write-off` | `[brewer]` | `operate` |
| GET | `production/deposit-invoices` | `[viewer, brewer, manager]` | `read` |
| POST | `production/deposit-invoices/backfill` | `[]` | `manage` |
| GET | `production/export-bay/active-allocation-check` | `[brewer]` | `operate` |
| POST | `production/export-bay/ship` | `[brewer]` | `operate` |
| POST | `production/export-bay/ship-adhoc` | `[brewer]` | `operate` |
| POST | `production/export-bay/ship/preview` | `[brewer]` | `operate` |
| POST | `production/export/invoice` | `[brewer]` | `operate` |
| GET | `production/export/invoice-preview` | `[brewer]` | `operate` |
| GET | `production/export/invoices` | `[viewer, brewer, manager]` | `read` |
| PATCH | `production/export/invoices/[id]/line-items` | `[brewer]` | `operate` |
| DELETE | `production/exports/[id]` | `[brewer]` | `operate` |
| PATCH | `production/exports/[id]` | `[brewer]` | `operate` |

#### `production.inventory` — 13 routes

| Method | Route | Legacy | Level |
|---|---|---|---|
| POST | `production/ingredients` | `[brewer]` | `operate` |
| DELETE | `production/ingredients/[id]` | `[brewer]` | `manage` |
| PATCH | `production/ingredients/[id]` | `[brewer]` | `manage` |
| POST | `production/ingredients/bulk` | `[brewer]` | `operate` |
| POST | `production/packaging` | `[brewer]` | `operate` |
| POST | `production/packaging-adjustments` | `[brewer]` | `operate` |
| POST | `production/packaging-adjustments/bulk` | `[brewer]` | `operate` |
| DELETE | `production/packaging/[id]` | `[brewer]` | `manage` |
| PATCH | `production/packaging/[id]` | `[brewer]` | `manage` |
| DELETE | `production/safety-stock` | `[]` | `manage` |
| POST | `production/safety-stock` | `[]` | `manage` |
| POST | `production/stock-adjustments` | `[brewer]` | `operate` |
| POST | `production/stock-adjustments/bulk` | `[brewer]` | `operate` |

#### `production.partners` — 11 routes

| Method | Route | Legacy | Level |
|---|---|---|---|
| POST | `partners/contract-brewing` | `[]` | `manage` |
| DELETE | `partners/contract-brewing/[id]` | `[]` | `manage` |
| PATCH | `partners/contract-brewing/[id]` | `[]` | `manage` |
| POST | `partners/contract-brewing/square-import` | `[]` | `manage` |
| POST | `partners/suppliers` | `[]` | `manage` |
| DELETE | `partners/suppliers/[id]` | `[]` | `manage` |
| PATCH | `partners/suppliers/[id]` | `[]` | `manage` |
| DELETE | `production/contract-requests` | `[brewer]` | `operate` |
| GET | `production/contract-requests` | `[viewer, brewer, manager]` | `read` |
| PATCH | `production/contract-requests` | `[brewer]` | `operate` |
| POST | `production/contract-requests` | `[brewer]` | `operate` |

#### `production.recipes` — 9 routes

| Method | Route | Legacy | Level |
|---|---|---|---|
| POST | `production/packaging-variations` | `[brewer]` | `operate` |
| DELETE | `production/packaging-variations/[id]` | `[brewer]` | `operate` |
| PATCH | `production/packaging-variations/[id]` | `[brewer]` | `operate` |
| POST | `production/packaging-variations/bulk` | `[brewer]` | `operate` |
| DELETE | `production/recipe-packaging-variations` | `[brewer]` | `operate` |
| POST | `production/recipe-packaging-variations` | `[brewer]` | `operate` |
| POST | `production/recipes` | `[brewer]` | `operate` |
| DELETE | `production/recipes/[id]` | `[brewer]` | `operate` |
| PATCH | `production/recipes/[id]` | `[brewer]` | `operate` |

#### `production.settings` — 11 routes

| Method | Route | Legacy | Level |
|---|---|---|---|
| PUT | `production/deposit-settings/invoice-due-days` | `[brewer]` | `manage` |
| GET | `production/export-settings/excise-tax-rates` | `[viewer, brewer, manager]` | `read` |
| PUT | `production/export-settings/invoice-due-days` | `[brewer]` | `manage` |
| POST | `production/export-settings/packaging-fee-class` | `[manager]` | `operate` |
| GET | `production/export-settings/service-mappings` | `[viewer, brewer, manager]` | `read` |
| PUT | `production/export-settings/service-mappings` | `[brewer]` | `manage` |
| GET | `production/export-settings/square-catalog` | `[viewer, brewer, manager]` | `read` |
| DELETE | `production/recipe-square-link-ignores` | `[brewer, manager]` | `operate` |
| POST | `production/recipe-square-link-ignores` | `[brewer, manager]` | `operate` |
| DELETE | `production/recipe-square-links` | `[brewer, manager]` | `operate` |
| POST | `production/recipe-square-links` | `[brewer, manager]` | `operate` |

#### `settings.business` — 1 routes

| Method | Route | Legacy | Level |
|---|---|---|---|
| PUT | `settings/timezone` | `[]` | `manage` |

#### `settings.cron` — 1 routes

| Method | Route | Legacy | Level |
|---|---|---|---|
| GET | `admin/cron-runs` | `[]` | `read` |

#### `settings.users` — 6 routes

| Method | Route | Legacy | Level |
|---|---|---|---|
| GET | `admin/requests` | `[]` | `manage` |
| PATCH | `admin/requests` | `[]` | `manage` |
| GET | `admin/users` | `[]` | `manage` |
| POST | `admin/users` | `[]` | `manage` |
| DELETE | `admin/users/[id]` | `[]` | `manage` |
| PATCH | `admin/users/[id]` | `[]` | `manage` |

#### `taproom.performance` — 8 routes

| Method | Route | Legacy | Level |
|---|---|---|---|
| POST | `production/taproom-consumption/dismiss-phantom` | `[manager]` | `operate` |
| GET | `production/taproom-consumption/phantom-alerts` | `[manager]` | `operate` |
| POST | `production/taproom-consumption/reconcile-phantom` | `[manager]` | `operate` |
| POST | `taproom/events` | `[manager]` | `operate` |
| DELETE | `taproom/events/[id]` | `[manager]` | `operate` |
| PUT | `taproom/events/[id]` | `[manager]` | `operate` |
| DELETE | `taproom/tap-swaps` | `[manager]` | `operate` |
| POST | `taproom/tap-swaps` | `[manager]` | `operate` |

#### `taproom.targets` — 3 routes

| Method | Route | Legacy | Level |
|---|---|---|---|
| DELETE | `manual-entries` | `[]` | `manage` |
| POST | `manual-entries` | `[]` | `manage` |
| POST | `targets` | `[]` | `manage` |

#### `tax` — 27 routes

| Method | Route | Legacy | Level |
|---|---|---|---|
| GET | `tax/authorities` | `[manager]` | `read` |
| GET | `tax/bank-account` | `[manager]` | `read` |
| PUT | `tax/bank-account` | `[]` | `manage` |
| GET | `tax/entity-profile` | `[manager]` | `read` |
| PUT | `tax/entity-profile` | `[]` | `manage` |
| GET | `tax/legal-representative` | `[manager]` | `read` |
| PUT | `tax/legal-representative` | `[]` | `manage` |
| GET | `tax/parties` | `[manager]` | `read` |
| GET | `tax/profiles/[party]` | `[manager]` | `read` |
| PUT | `tax/profiles/[party]` | `[]` | `manage` |
| GET | `tax/rates` | `[manager]` | `read` |
| GET | `tax/registrations` | `[manager]` | `read` |
| PUT | `tax/registrations` | `[]` | `manage` |
| GET | `tax/schedules` | `[manager]` | `read` |
| POST | `tax/schedules` | `[]` | `manage` |
| DELETE | `tax/schedules/[id]` | `[]` | `manage` |
| PATCH | `tax/schedules/[id]` | `[]` | `manage` |
| GET | `tax/square-taxes` | `[manager]` | `read` |
| GET | `tax/tasks` | `[manager]` | `read` |
| GET | `tax/tasks/[id]` | `[manager]` | `read` |
| PATCH | `tax/tasks/[id]` | `[manager]` | `operate` |
| POST | `tax/tasks/[id]/complete` | `[manager]` | `operate` |
| GET | `tax/tasks/[id]/files` | `[manager]` | `read` |
| POST | `tax/tasks/[id]/files` | `[manager]` | `operate` |
| DELETE | `tax/tasks/[id]/files/[fileId]` | `[manager]` | `operate` |
| GET | `tax/tasks/[id]/files/[fileId]` | `[manager]` | `read` |
| POST | `tax/tasks/[id]/recompute` | `[manager]` | `operate` |

#### `tax.pii` — 3 routes

| Method | Route | Legacy | Level |
|---|---|---|---|
| GET | `tax/bank-account/reveal` | `[]` | `admin` |
| GET | `tax/legal-representative/reveal` | `[]` | `admin` |
| GET | `tax/profiles/[party]/reveal` | `[]` | `admin` |
