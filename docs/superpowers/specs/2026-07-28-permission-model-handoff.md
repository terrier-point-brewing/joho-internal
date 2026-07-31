# Permission model + settings consolidation — handoff brief

**Date:** 2026-07-28
**Status:** problem statement and verified findings. No design approved. No code written.
**Goal:** a scalable grant system giving tight control over which roles reach which parts of the app — and, riding on it, consolidation of four scattered settings surfaces into one hub.

Every fact below was verified against the working tree this session. Line references are real.

---

## 1. The core problem

The scope tree is being asked to serve three purposes simultaneously:

1. **Nav mirror** — where the screen lives (`/finance/tax` → `tax`)
2. **Domain model** — what the permission protects (payroll data, regardless of route)
3. **Admission control** — who gets into a section at all

These agree until a capability is reachable from two places, or a screen moves. Then they conflict, and today the conflict is resolved ad hoc, differently each time.

Concrete instances:

| Instance | Collision |
|---|---|
| Square Item Mappings | one component, two routes, two different gates |
| Payroll | one scope, two UIs of different depth (Finance, Taproom) |
| Tax | its own top-level section, but nested under Finance in nav |
| Settings consolidation | moving screens moves their gates — the trigger for this whole effort |

**Any proposed model must state which of the three purposes the scope tree serves, and how the other two are expressed.** Not answering this is what produced the mess.

---

## 2. Current state (verified)

### 2.1 Resolution model

- `ScopeGrants = Partial<Record<ScopeKey | Section | ROOT, Level>>` — grants at root, section, or leaf.
- `effectiveLevel()` in `lib/auth/resolve.ts` — longest-prefix-wins, dot-delimited.
- Ladder in `lib/auth/levels.ts`: `none(0) < read(1) < operate(2) < manage(3) < admin(4)`.
- `none` is a **storable explicit revoke**, distinct from an absent grant.
- 20 scopes across 7 sections (`lib/auth/scopes.ts`).
- Four static roles resolve from the hardcoded `ROLE_BUNDLES` (`lib/auth/roleGrants.ts`) with **zero DB round-trips**; `custom` reads `user_permission_grants`.
- `payroll` and `tax` are both a Section and a leaf ScopeKey. `GrantMatrix.tsx:82` filters `key !== section` to avoid double-rendering.

### 2.2 Admission gating is done five different ways

| Section | Mechanism | Scope used |
|---|---|---|
| production | layout redirect | `production.settings:read` — chosen only because every non-viewer bundle happened to grant it |
| finance | layout redirect | `finance.statements:read` — a content scope |
| brand | layout redirect | `brand.guide:read` — a content scope |
| taproom | **none** | no layout gate exists; API-layer only |
| settings | layout redirect | session only, no scope |

`production.settings` is **load-bearing**: `app/production/layout.tsx` gates all of Brewing, Inventory, Export, Recipes, Partners, and Equipment on it. Renaming or removing it without a replacement locks manager out of the entire section.

### 2.3 Role bundles as they stand

- `admin` = `{ "": "admin" }` — one row.
- `manager` = `taproom:operate`, `taproom.targets:read`, `payroll:operate`, `tax:operate`, `production.export:read`, `production.partners:read`, `production.settings:operate`. **No finance grant of any kind.**
- `brewer` = production leaves (`production.settings:manage`), `taproom.performance:read`, `taproom.targets:read`.
- `viewer` = `taproom.performance:read`, `taproom.targets:read`.

Manager reaches `taproom.performance` at `operate` and `tax.pii` at `operate` purely by **prefix inheritance** from bare `taproom` and `tax` grants — not by declaration. Any per-leaf rewrite of the bundles changes behavior.

### 2.4 The DB mirrors part of this

`supabase/migrations/20260822_rls_grant_aware_policies.sql`:

- `effective_grant_level(p_scope text)` is a SQL mirror of `effectiveLevel()`, returning NULL unless the caller is `role = 'custom'`.
- Payroll policies gate on `get_my_role() = any (payroll_reader_roles())` — a **hardcoded role-name array** `{manager, admin}`.
- The `permission_level` enum ordering is documented as a LOAD-BEARING coupling with `RANK` in TS.
- `finance_reader_roles()` returns an empty array **on purpose** — those tables are service-role-only.

Implication: preset-role permissions live in two hardcoded places (TS bundles, SQL role arrays). Only the `payroll` scope is mirrored in SQL, so renaming any *other* scope does not require a policy change.

---

## 3. Defects found (independent of any redesign)

1. **Page gate ≠ API gate across all 8 finance settings screens.** Pages gate on `finance.statements:read`; not one of their APIs uses that scope — they use `finance.transactions`, `payroll`, or `tax`. Manager holds enough for the payroll and tax APIs but is blocked at the door.
2. **One component, two gates.** `app/taproom/settings/square-links/page.tsx` imports `SquareMappingsPanel` from production. Via taproom it's gated `taproom.settings`; via production, `production.settings`. Its APIs only ever check `production.settings`.
3. **Cross-scope action inside a page.** `MappingGrid.tsx:80` calls `/api/finance/sync-catalog`, gated `finance.transactions:manage`. A brewer sees a button that always 403s.
4. **Open-but-can't-save.** Deposit Settings opens at `production.settings:read`, saves at `:manage`. Manager gets a dead form with no affordance.
5. **`taproom.settings` has no API of its own** — the layout redirect is its only enforcement. A custom grant of it alone yields a page where every write 403s.
6. **`brand.guide:manage` conflates two powers** — editing brand guide content (`/api/brand/canon/*`) and reskinning the entire internal app for every user.
7. **`/taproom/performance` and `/taproom/targets` have no server-side page or layout gate.** No access difference today (viewer holds `read` on both), but it is the one section with no gate.

---

## 4. Open design questions

1. **Which purpose does the scope tree serve** — nav, domain, or admission? (See §1. Answer this first; everything else follows.)
2. **Uniform `<section>.access`?** Would make admission explicit and consistent, replacing five ad hoc mechanisms. Cost: one new scope per section plus bundle rows.
3. **Does `tax` nest under `finance`?** Nav says yes. Constraint: manager holds `tax:operate` with no finance grant, so it only works with an explicit `finance.tax` leaf and never a bare `finance` grant.
4. **Where do settings scopes live** — `settings.<domain>` (mirrors the new hub) or `<domain>.settings` (mirrors the data)? The user rejected `production.settings` in favour of `settings.production`, but this is really question 1 in disguise.
5. **Cross-section capabilities.** Square Item Mappings is the live case; it will not be the last.
6. **One scope, two UIs of differing depth** (payroll). The level ladder already handles this — `/taproom/payroll` gates at `read`, finance payroll APIs use `read`/`operate`/`manage`. Confirm this is sufficient rather than splitting the scope.
7. **Editable preset-role bundles.** Requested. Requires teaching Postgres to resolve bundles (they are TS-only today), and adds a DB read per request where static roles currently do none. `GrantMatrix.tsx` already provides the editor UI. Lower urgency than it appears: an admin can already reproduce any bundle by setting a user to `custom`. **Recommend a separate spec.**

---

## 5. Decisions the user has already made

| # | Decision |
|---|---|
| 1 | **Approach B** — one settings hub; all settings move under `/settings`. Not four surfaces. |
| 2 | Inner segments use **nested routes**, not client state or query params. |
| 3 | Subtabs are **independently gated**. Section-attributable subtabs ride that section's grants; cross-section ones get their own. |
| 4 | Ride-along is at **manage** level, not read/operate. |
| 5 | **No widening of the manager role.** |
| 6 | Manager loses Production settings — achieved by gating the subtab at `manage`, **not** by removing their `production.settings` grant (which would lock them out of all of `/production`). |
| 7 | **Drop per-section Settings nav entries entirely.** No links back from Finance/Production/Taproom navs. |
| 8 | `taproom.settings` retires with zero screens — accepted. |
| 9 | Finance settings re-key from `finance.statements` → `finance.transactions` — approved. |
| 10 | Gate the Sync Catalog button on `finance.transactions:manage` — approved (removes a button that 403s). |

The user is preparing a cleaned-up role→grant mapping against the final scope structure.

---

## 6. Scope inventory: the 18 settings screens

| Surface | Screens | Current gate |
|---|---|---|
| `/settings` | Account, Appearance, Business, Users, Access Requests, Cron Jobs | per-page `getSessionUser` + `can()` |
| `/finance/settings` | Chart of Accounts (1018 LOC), Account Mapping (815), Expense Accounts (140), Counterparty Accounts (181), Payroll Dept Mappings (225), Payroll (574), Tax Profile (63), Tax Filing (96) | one layout gate |
| `/production/settings` | Deposit Settings, Export Settings, Square Item Mappings | one layout gate |
| `/taproom/settings` | Square Item Mappings (same component) | one layout gate |

Deliberately scope-less, and should stay that way: **own password** (gating it is a lockout risk) and **own theme** (per-browser cookie, a display preference).

---

## 7. Implementation constraints

- `npm run verify` (lint + typecheck + tests) must pass.
- Move page components near-unmodified. This is routing + gating, **not** a rewrite of the 815/1018-LOC pages.
- Redirects required from every old path — two live inbound deep links: `GustoUploadPanel.tsx:131` and `counterparty-accounts/page.tsx:150`, both to `payroll-department-mappings`.
- **Cross-feature import:** `app/production/components/ExportSettingsPanel.tsx:15` imports `@/app/finance/settings/tax-filing/ExciseRatesSection`. Moving that folder breaks a production component.
- `app/finance/settings/excise-tax/page.tsx` is a 5-line redirect referenced by no nav — dead, delete it.
- Any scope rename needs a migration rewriting `user_permission_grants` rows. Prod migrations are **human-gated** — orchestrator only, after explicit approval.
- **Concurrent branch** `claude/tips-pl-exclusion-a91722` is adding a tips-liability GL account picker to `payroll-department-mappings` and its API route. Coordinate or rebase; do not revert its field.
- UI work follows `docs/UI_STANDARD.md`: reuse `SubNav`, `TabBar`, `Card`, `PageHeader`; no raw color utilities.
- Adding a `Section` value is compile-error-guarded by `SECTION_LABELS: Record<Section, string>` in `GrantMatrix.tsx:65`.

---

## 8. Suggested order of work

1. Settle question 1 in §4 — what the scope tree models. Everything else is downstream.
2. Derive the scope registry from that answer, including admission.
3. Map old → new scopes and write the grant migration.
4. Re-verify every static role against the current matrix; any movement must be intentional and listed.
5. Only then do the routing consolidation, which is mechanical once the gates are settled.
6. Editable preset-role bundles as a separate spec.

**Do not start at step 5.** The routing looks like the task and is the easy part; the gating is the task.
