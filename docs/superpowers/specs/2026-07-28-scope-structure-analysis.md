# Scope structure — investigation findings (A1–A7)

**Date:** 2026-07-28
**Status:** investigation only. No code written, no migration written, no decision made.
**Inputs:** `2026-07-28-scope-structure-spec.md` (normative), `2026-07-28-permission-model-handoff.md` (brief, 10 binding decisions), `2026-07-28-current-role-scope-matrix.csv`.
**Working tree:** `claude/scope-structure-spec-81fb9f` @ `f26ea5c`.

Every claim below was verified against the tree or against prod Postgres this session. Line references are real.

---

## A1. Registry classification — all 20 keys through §4

| # | Key | §4 step that decides it | Verdict |
|---|---|---|---|
| 1 | `taproom.performance` | 4 (one section) | ✅ leaf, unchanged |
| 2 | `taproom.targets` | 4 (one section) | ✅ leaf, unchanged |
| 3 | `taproom.settings` | 1+2 | ❌ **misfit** — admission-shaped (layout redirect is its *only* enforcement) and its one screen belongs to `catalog`. Retire (decision #8). |
| 4 | `production.brewing` | 4 | ✅ leaf |
| 5 | `production.inventory` | 4 | ✅ leaf |
| 6 | `production.export` | 4 | ✅ leaf |
| 7 | `production.recipes` | 4 | ✅ leaf |
| 8 | `production.partners` | 4 | ✅ leaf |
| 9 | `production.equipment` | 4 | ✅ leaf |
| 10 | `production.settings` | 1+2+4 | ❌ **misfit, 3-way** — see A5. Splits into `production.access` (admission), `production.settings` (Export/Deposit config), `catalog` (Square mappings). |
| 11 | `finance.transactions` | 4 | ✅ leaf; its `manage` face absorbs the 4 accounting settings screens (decision #9) |
| 12 | `finance.statements` | 1+4 | ❌ **misfit, 2-way** — content scope moonlighting as the finance door. Splits into `finance.access` + `finance.statements`. |
| 13 | `payroll` | 4 (two sections) | ✅ top-level shared, unchanged |
| 14 | `tax` | 4 (one section: every tax screen is under `/finance/**`) | ❌ **mis-levelled** — belongs at `finance.tax` |
| 15 | `tax.pii` | 5 | ❌ **mis-levelled** — `finance.tax.pii` |
| 16 | `brand.guide` | 1+2 | ❌ **misfit, 2-way + door** — conflates brand content with app-wide reskin, *and* serves as brand's admission gate. Splits into `brand.access` + `brand.guide` + `org.appearance`. |
| 17 | `brand.workbench` | 4 | ✅ leaf — **but absent from the spec's §3 tree. Omission, not a conflict** (see Findings). |
| 18 | `settings.business` | 2 | ❌ **Axis-3 leak** — `settings.` is a *place*. The domain is org administration → `org.business`. |
| 19 | `settings.users` | 2 | ❌ same → `org.users` |
| 20 | `settings.cron` | 2 | ❌ same → `org.jobs` |

**Misfit count: 9 of 20.** Every one of them is an instance of the §1 diagnosis (one axis borrowing another's mechanism), and none of them resists the placement procedure.

**Resulting registry size: 26 keys** (20 − 1 retired + 7 new). New keys: `taproom.access`, `production.access`, `finance.access`, `brand.access`, `finance.tax.filing`, `catalog`, `org.appearance`.

---

## A2. Three-segment key + interior-node support

| Component | File | Handles 3 segments? | Work required |
|---|---|---|---|
| Resolver | `lib/auth/resolve.ts:18` | ✅ yes — `scope.startsWith(key + ".")` + longest-`length` wins is depth-agnostic | **none** |
| SQL mirror | `20260822_rls_grant_aware_policies.sql:56-59` | ✅ yes — `starts_with(p_scope, g.scope \|\| '.')`, `order by length desc` | **none.** Only `'payroll'` is ever passed (A7) |
| `ScopeGrants` type | `lib/auth/resolve.ts:5` | ⚠️ conditional — `ScopeKey \| Section \| ROOT`. `finance.tax` is grantable **iff** it's a `SCOPES` entry | add `finance.tax` (and `catalog`) as SCOPES entries; no type change |
| `can()` signature | `lib/auth/resolve.ts:28` | ⚠️ same — takes `ScopeKey`, so any *checked* interior node must be in SCOPES | same |
| `GrantMatrix` — `ancestorLevel` | `GrantMatrix.tsx:37-49` | ✅ depth-agnostic | **none** |
| `GrantMatrix` — `LEAVES_BY_SECTION` | `GrantMatrix.tsx:79-87` | ⚠️ renders flat. Finance would show 5 flat siblings (`statements`, `transactions`, `tax`, `tax.filing`, `tax.pii`) | small: indent by dot-count. Functionally correct either way |
| `GrantMatrix` — `key !== section` filter | `GrantMatrix.tsx:82` | ✅ still correct — it only dedupes `payroll`/`catalog` (Section == ScopeKey). It never fires at `finance.tax` | **none** |
| `SECTION_LABELS` | `GrantMatrix.tsx:65` | ✅ `Record<Section,string>` — adding `org`/`catalog` is a compile error until handled | mechanical |
| `SECTION_ORDER` | `GrantMatrix.tsx:64` | ⚠️ **un-guarded hole** — a plain `Section[]` literal. Removing `tax` from `Section` *is* caught; **adding** `org` is silently omitted from the UI | add an exhaustiveness assertion while we're here |
| `roleGrants.test.ts:7,24` | — | ❌ hardcodes the 7 sections and `toBe(20)` | mechanical |
| `check-permissions.mjs:78,85` | — | ❌ hardcodes `!== 20`; rule 4 requires **every** scope to have a CAP entry | mechanical — but all 7 new scopes need CAP entries or the guard fails |
| `capability-coordinates.test.ts` | — | ❌ frozen verbatim copy of the CAP table | must move in lockstep |
| `__fixtures__/legacy-matrix.ts` (230 rows) | — | ⚠️ rows key on **CAP names**, not scope strings | **zero churn if CAP entry names stay stable** and only their `scope:` coordinates change (e.g. keep `taxRead`, retarget to `finance.tax`). Recommended. |

**Verdict: no blocker anywhere.** Nothing in the resolver, the SQL, or the matrix assumes exactly two segments. The work is registry + CAP + three test/guard constants. Effort: contained, mechanical, one locality group.

---

## A3. Surface × domain matrix

### A3.1 Admission (the five ad hoc mechanisms — brief §2.2 confirmed verbatim)

| Section | Current gate | File | Proposed |
|---|---|---|---|
| production | `production.settings:read` | `app/production/layout.tsx:11` | `production.access:read` |
| finance | `finance.statements:read` | `app/finance/layout.tsx:7` | `finance.access:read` |
| brand | `brand.guide:read` | `app/brand/layout.tsx:25` | `brand.access:read` |
| taproom | **none** | — | `taproom.access:read` (new layout) |
| settings hub | session only | `app/settings/layout.tsx:6` | session only (decision #3) |
| `/taproom/payroll` | `payroll:read` | `app/taproom/payroll/layout.tsx:7` | unchanged + `taproom.access:read` above it |
| `/taproom/settings` | `taproom.settings:operate` | `app/taproom/settings/layout.tsx:13` | **deleted** |

Client nav mirrors the same three keys: `NavBar.tsx:96-98`.

### A3.2 Screens → owning scope

87 non-API route pages. Only 9 carry a page-level gate; the rest inherit from a layout or are ungated client components.

| Screen group | Routes | Current gate | Proposed scope : level |
|---|---|---|---|
| Taproom Performance | `/taproom/performance/{sales-pulse,draft-stats,inventory,events}` | **none** (defect 7) | `taproom.access:read` + `taproom.performance:read` |
| Taproom Targets | `/taproom/targets/{achievement,target-setting,manual-entries}` | **none** (defect 7) | `taproom.access:read` + `taproom.targets:read` |
| Taproom Payroll | `/taproom/payroll`, `/[periodId]` | `payroll:read` | `taproom.access:read` + `payroll:read`/`operate` per affordance |
| Taproom Settings | `/taproom/settings/square-links` | `taproom.settings:operate` | **retired** → hub, `catalog` |
| Production (all) | `/production/{intake,brewing/*,export,recipes/*,inventory,partners}` | `production.settings:read` (layout) | `production.access:read` + per-leaf |
| Production Settings | `/production/settings/{deposits,export}` | `production.settings:read` (layout only) | `production.settings:manage` in hub |
| Production Settings | `/production/settings/square-links` | `production.settings:read` (layout only) | `catalog` in hub |
| Finance Statements | `/finance/statements/*`, `/finance/financials`, `/finance/model` | `finance.statements:read` (layout) | `finance.access:read` + `finance.statements:read` |
| Finance Transactions | `/finance/transactions/*`, `/finance/expenses`, `/finance/invoices`, `/finance/import`, `/finance/sales/*` | `finance.statements:read` (layout) | `finance.access:read` + `finance.transactions:read` |
| Finance Tax | `/finance/tax`, `/finance/tax/[taskId]` | `finance.statements:read` (layout) | `finance.access:read` + `finance.tax:read`/`operate` |
| Finance Payroll | `/finance/payroll`, `/[periodId]` | `finance.statements:read` (layout) | `finance.access:read` + `payroll:manage` |
| Fin. settings — accounting | `/finance/settings/{chart-of-accounts,account-mapping,expense-accounts,counterparty-accounts}` | `finance.statements:read` (layout) | `finance.transactions:manage` (decision #9) |
| Fin. settings — payroll | `/finance/settings/{payroll,payroll-department-mappings}` | `finance.statements:read` (layout) | `payroll:manage` |
| Fin. settings — tax | `/finance/settings/{tax-profile,tax-filing}` | `finance.statements:read` (layout) | `finance.tax.filing:manage` / `finance.tax.pii:manage` |
| Fin. settings — dead | `/finance/settings/excise-tax` | 5-line redirect, no nav ref | **delete** (brief §7) |
| Brand | `/brand/{guide,canon,canon/history,preview}` | `brand.guide:read` (layout) | `brand.access:read` + `brand.guide:read`/`manage` |
| Brand workbench | `/brand/{assets,releases}` | `brand.guide:read` + `brand.workbench:manage` | `brand.access:read` + `brand.workbench:*` |
| Settings hub | `/settings/{account,appearance,business,users,requests,cron}` | session + per-page CAP | session + `org.*` |

**Confirmed: page gate ≠ API gate on all 8 finance settings screens** (brief defect 1). Not one of them calls an API gated on `finance.statements` — see A3.3.

### A3.3 API routes → scope (the authority side)

162 route files. Gate distribution by scope:

| Scope | Routes | Notable |
|---|---|---|
| `finance.transactions` | 34 | all accounting settings APIs + transactions/ledger/expenses |
| `finance.statements` | 4 | `cogs`, `financials`, `pl`, `taxes` — **statements only.** Nothing else uses it. |
| `tax` | 20 | `/api/tax/**` — read 14, operate 5, manage 10, pii 3 |
| `payroll` | 12 | `/api/payroll/**` + `/api/finance/{payroll-periods,settings/payroll-department-mappings}` |
| `production.*` (7 leaves) | ~60 | see A5 for the `production.settings` split |
| `taproom.performance` | 6 | events, tap-swaps, phantom reconciliation |
| `taproom.targets` | 2 | `/api/targets`, `/api/manual-entries` |
| `taproom.settings` | **0** | brief defect 5 confirmed |
| `brand.guide` / `brand.workbench` | 5 / 5 | canon+chrome / assets+labels |
| `settings.*` | 6 | `/api/admin/{users,requests,cron-runs}`, `/api/settings/timezone` |
| **ungated** | **29** | session-only via `proxy.ts:54`. See Findings F4. |

Screen→API mapping for the settings surfaces (used to derive the re-keys):

| Screen | APIs it calls | API's scope today |
|---|---|---|
| CoA / Account Mapping / Expense Accts / Counterparty Accts | `/api/finance/{chart-of-accounts,account-mappings,account-mappings/bulk,expense-mappings,expense-counterparty-mappings,sync-catalog}` | `finance.transactions` |
| Payroll Dept Mappings | `/api/finance/settings/payroll-department-mappings`, `/api/finance/chart-of-accounts` | `payroll` + `finance.transactions` |
| Payroll settings | `/api/payroll/{config,employees,employees/sync-square}` | `payroll:manage` |
| Tax Profile | `/api/tax/{authorities,bank-account,entity-profile,legal-representative,registrations}` | `tax` + `tax.pii` |
| Tax Filing | `/api/tax/{parties,profiles/*,square-taxes}` | `tax` + `tax.pii` |
| Deposit Settings | `/api/production/deposit-settings/invoice-due-days` | `production.settings:manage` |
| Export Settings | `/api/production/export-settings/{invoice-due-days,packaging-fee-class,service-mappings,excise-tax-rates}` | `production.settings` (read/operate/manage) |
| Square Item Mappings | `/api/production/{recipe-square-links,recipe-square-link-ignores,square-catalog}` + `/api/finance/sync-catalog` | `production.settings:operate`, **ungated**, `finance.transactions:manage` |

---

## A4. Where manager's `tax:operate` is actually exercised

**Answer: nowhere in the UI. It is API-reachable only, and no reachable UI calls those APIs.**

- Every tax screen lives under `/finance/**`: `/finance/tax`, `/finance/tax/[taskId]`, `/finance/settings/tax-profile`, `/finance/settings/tax-filing`, `/finance/settings/excise-tax`.
- `app/finance/layout.tsx:7` gates the whole section on `finance.statements:read`.
- Manager's bundle has **no finance key of any kind** (`roleGrants.ts:18`, asserted by `roleGrants.test.ts:34-37`).
- ⇒ Manager is redirected to `/` before any tax page renders. Their `tax:operate` grant satisfies 25 API routes that no manager-reachable screen ever calls.

The only non-`/finance` consumer of a tax-adjacent API is `ExportSettingsPanel.tsx:561` → `ExciseRatesSection`, and that reads `/api/production/export-settings/excise-tax-rates`, which is gated `production.settings:read` — not `tax`.

**This makes Q-W1 a live decision, not a status-quo question:** granting manager `finance.access:read` *adds* the tax UI they cannot currently see. Withholding it preserves today's behavior, which is that manager's tax grant is dead weight.

---

## A5. `catalog` vs residual `production.settings`

Derived from the actual API calls in `app/production/settings/square-links/**` (the only consumer of `SquareMappingsPanel`, mounted at two routes).

**→ `catalog`:**

| Endpoint | Gate today | Notes |
|---|---|---|
| `/api/production/recipe-square-links` (GET/POST/DELETE) | `production.settings:operate` | `MappingDrawer.tsx:169,195`, `MappingGrid.tsx:36` |
| `/api/production/recipe-square-link-ignores` (POST/DELETE) | `production.settings:operate` | `MappingDrawer.tsx:213,234` |
| `/api/production/square-catalog` (GET) | **none** | `MappingDrawer.tsx:133` — see F4 |

**→ stays `production.settings` (production-only config):**

| Endpoint | Gate today |
|---|---|
| `/api/production/deposit-settings/invoice-due-days` | `manage` |
| `/api/production/export-settings/invoice-due-days` | `manage` |
| `/api/production/export-settings/service-mappings` | `read`/`manage` |
| `/api/production/export-settings/packaging-fee-class` | `operate` |
| `/api/production/export-settings/excise-tax-rates` | `read` — **placement question, see Q-W4** |

**→ neither (already correctly finance):** `/api/finance/sync-catalog` — `finance.transactions:manage`, called from `MappingGrid.tsx:80`. Decision #10 already covers gating that button.

---

## A6. Grant population report

Queried against prod (`drlsazatrcrdwaihjmex`) this session, read-only.

**Total users: 5.** viewer 1, brewer 2, admin 1, **custom 1**.

The single custom user — `jeffkliao@gmail.com` (`9032f759…`) — holds **seven bare section grants, all at `read`**, and nothing else:

```
brand: read    finance: read   payroll: read   production: read
settings: read taproom: read   tax: read
```

Migration impact, per A6's four questions:

| A6 question | Population | Impact |
|---|---|---|
| Holds bare `finance`? | **1** — jeffkliao | Nesting tax under finance is a **no-op** for them: they already hold bare `tax: read`, which covers `tax.pii` at read. After migration `finance: read` covers `finance.tax.*` identically. The `tax → finance.tax` row rewrite produces a redundant-but-harmless row. |
| Holds `brand.guide:manage`? | **0** | **Q-W5 is moot.** No user loses reskin ability. Only `admin` (ROOT) has it. |
| Holds any `tax*` key? | **1** — jeffkliao (`tax: read`) | Rewrite `tax → finance.tax`. No `tax.pii` rows exist. |
| Holds any `production.settings`? | **1** — jeffkliao, **by prefix** from `production: read` | ⚠️ **Real narrowing.** After the `catalog` split, bare `production: read` no longer reaches Square Item Mappings. Preserving today's access needs an explicit `catalog: read` row. |
| Holds `settings.*`? | **1** — jeffkliao, by prefix from `settings: read` | `settings` ceases to be a Section. Needs `settings: read` → `org: read` or they lose the Cron Jobs tab (`settings.cron:read` is the only `settings.*` scope gated below `manage`). |

**Migration row count: 7 rows, 1 user.** Two of them (`tax`, `settings`) are renames; one (`catalog: read`) is an addition needed to avoid silent narrowing. The blast radius of this entire migration is one non-admin account.

---

## A7. Literal scope-string grep

Grepped `app/`, `lib/`, `supabase/`, `scripts/` for `'tax'`, `"tax"`, `tax.pii`, `payroll`, `production.settings`, `taproom.settings`, `finance.statements`, `brand.guide`, `settings.*`.

**Scope strings are well contained.** Every literal lives in exactly one of:

1. `lib/auth/scopes.ts` — the registry
2. `lib/auth/capabilities.ts` — the CAP table (the only place a scope meets a level)
3. `lib/auth/roleGrants.ts` — the bundles
4. `app/settings/users/GrantMatrix.tsx:64` — `SECTION_ORDER` (the one UI literal)
5. tests: `resolve.test.ts`, `roleGrants.test.ts`, `session.test.ts`, `rlsGrantParity.test.ts`, `capability-coordinates.test.ts`
6. SQL: **`'payroll'` only**, at `20260822_rls_grant_aware_policies.sql:171` and in a comment at `:185`

**No tax literal exists anywhere in SQL.** No route handler or component hardcodes a scope string — they all go through `CAP.*`. The brief's claim (§2.4) that only `payroll` is mirrored in SQL is confirmed. `payroll_reader_roles()` and friends are untouched by every rename in §5.

False positives excluded: `lib/constants/categories.ts:83` (`"excise tax"` product-name matching), `lib/query-keys.ts:127-129` (React Query cache keys).

---

## Findings the spec didn't know

**F1 — `brand.workbench` is missing from the §3 tree.** It exists today, gates `/brand/assets`, `/brand/releases`, and 10 API routes across `/api/brand/{assets,labels}`. §4 step 4 classifies it cleanly as a `brand` leaf. Treating this as an omission and keeping it; no structural conflict. Corrected registry size is therefore 26, not 25.

**F2 — manager currently *can* edit Square Item Mappings, and the proposed levels take that away.** Manager holds `taproom:operate` → resolves `taproom.settings:operate` → passes `app/taproom/settings/layout.tsx:13`; the write APIs need `production.settings:operate`, which manager also holds. So `/taproom/settings/square-links` works for manager today. Under the proposal, that route is deleted (decision #7/#8), Square Item Mappings lives only in the hub, and if the hub subtab gates at `catalog:manage` (decision #4's threshold) while manager gets `catalog:operate` (Q-W2), **manager loses mapping editing entirely.** Folded into Q-W2/Q-W3 below.

**F3 — decision #4's `manage` threshold may not apply to `catalog`.** Decision #4 reads "*ride-along* is at manage level." Decision #3 distinguishes section-attributable subtabs (which ride a section's grants) from cross-section ones (which "get their own"). `catalog` is the latter — it has its own key, so it isn't riding anything. The hub gate level for `catalog` is therefore an open choice, not a consequence of decision #4. This is what makes F2 resolvable without reopening decision #4.

**F4 — 29 API routes have no `requirePermission` at all.** They are session-gated by `proxy.ts:54` but scope-free. One is directly in scope here: **`/api/production/square-catalog`** — the Square variation list the mapping drawer reads — is readable by any authenticated user. It should become `catalog:read` as part of the re-key. The other 28 (`/api/production/{cold-storage,demand-calendar,exports,transfer-log,…}`, `/api/taproom/{draft-stats,inventory,tap-config}`, `/api/{sales-pulse,net-sales-summary,combo-sales}`, cron/webhook routes which authenticate themselves) are outside this spec's scope — flagging, not fixing.

**F5 — `legacy-matrix.ts` (230 rows) keys on CAP *names*, not scope strings.** Renaming CAP entry names would force 230 fixture edits for zero behavior change. Recommendation: keep CAP names stable (`taxRead` stays `taxRead`) and change only their `scope:` coordinates. The fixture then needs no edit at all.

---

## Questions for Will

Evidence attached to each. Nothing is implemented until these are answered.

### Q-W1 — Does manager get `finance.access:read`?

**Evidence (A4):** manager's `tax:operate` is currently **unreachable in the UI** — every tax screen is under `/finance/**`, and the finance layout gates on `finance.statements:read`, which manager does not hold.

So this is not "preserve behavior," it's a choice:

- **(a) Grant manager `finance.access:read`** — admission only, no authority. Manager gains `/finance/tax` (schedules + filing tasks at `operate`), and *only* that: `finance.statements` and `finance.transactions` remain unheld, so every other finance subtab still denies. Arguably not "widening" under decision #5 since no new authority is conferred — but it does surface a section they've never seen.
- **(b) Withhold it** — manager's tax grant stays dead weight in the UI. Their day-to-day tax work would have to move to a non-finance surface, which doesn't exist today and isn't in scope.
- **(c) Drop manager's tax grant** — honest about what's actually happening, but a capability removal you haven't asked for.

**My read: (a).** Manager holding `tax:operate` is clearly deliberate (it's in the bundle by hand), and today's inaccessibility looks like defect 1 rather than intent.

### Q-W2 — `catalog` migration levels

Proposed in §6: brewer `production.settings:manage → catalog:manage`; manager `:operate → catalog:operate`.

**Confirm, with F2/F3 attached:** if the hub's Catalog subtab gates at `catalog:manage`, manager at `operate` loses Square Item Mappings editing, which they can do today via `/taproom/settings/square-links`. Three ways out:

- **(i) Gate the hub's Catalog subtab at `catalog:operate`** and keep the proposed grant levels. Justified by F3 — `catalog` is a cross-section scope with its own key, not a ride-along, so decision #4's `manage` threshold doesn't bind it. Manager keeps exactly today's ability. **Recommended.**
- (ii) Give manager `catalog:manage`. Preserves ability but is a level bump on a shared scope.
- (iii) Accept the loss. Manager stops editing mappings.

### Q-W3 — Confirm: manager sees zero settings subtabs in the hub?

With Q-W1(a) and Q-W2(i), manager's hub would show: nothing at `manage` (production `operate`, payroll `operate`, tax `operate`), plus **Catalog** if you take Q-W2(i). Confirm that's the intent — day-to-day payroll/tax operation continues through non-hub surfaces (`/taproom/payroll`, `/finance/tax`), and the hub is genuinely configuration-only.

### Q-W4 — Owning scope for two screens A3 couldn't attribute cleanly

1. **Deposit Settings** — spec default `production.settings`. Nothing contradicts it; its only API is `/api/production/deposit-settings/invoice-due-days` at `production.settings:manage`. **Confirm the default.**
2. **Excise rates** — genuinely ambiguous. `ExciseRatesSection` lives in `app/finance/settings/tax-filing/` but is rendered by `app/production/components/ExportSettingsPanel.tsx:561`, and reads `/api/production/export-settings/excise-tax-rates`, gated `production.settings:read`. Shortlist: **(a)** keep as `production.settings` (matches the API and the rendering site, ignores where the file lives); **(b)** re-key to `finance.tax.filing:read` (matches the domain — excise rates *are* tax reference data — and makes the cross-import a legitimate domain boundary rather than an accident). **Recommend (b)**, since §1 says placement follows domain, not file location. It costs brewer read access to excise rates unless they get `finance.tax.filing:read`.

### Q-W5 — Moot, no answer needed

**Zero users hold `brand.guide:manage`** outside `admin` (which holds ROOT). Splitting `org.appearance` out narrows nobody. Proceeding with the spec's default (narrow) unless you say otherwise.

### Q-W6 — Naming sign-off: `org`, `catalog`, `finance.tax.filing`

Cheap now, expensive after grant rows exist. Two notes:

- **`org`** reads as a place ("the settings hub") the same way `settings.*` did — the very Axis-3 leak §1 forbids. It survives the test only because org administration genuinely *is* a domain (users, business identity, jobs, appearance) that happens to be consumed by one section. Worth a beat of confirmation. Alternative if it bothers you: `admin` — but that collides with the level name.
- **`catalog`** is unqualified. It means the Square item catalog specifically. `square.catalog` or `mappings` would be more literal; `catalog` is fine if you're comfortable that this codebase will never grow a second catalog concept.

### Q-W7 (new) — Migration rows for `jeffkliao@gmail.com`

The full blast radius is one account, seven rows. Two of the rewrites are mechanical; two are judgment calls:

| Current row | Proposed | Why it's a question |
|---|---|---|
| `tax: read` | `finance.tax: read` | mechanical — redundant once `finance: read` exists, but harmless |
| `settings: read` | `org: read` | **needed or they lose the Cron Jobs tab.** Confirm they should keep it. |
| `production: read` | *(unchanged)* + **add `catalog: read`** | **needed or they silently lose Square Item Mappings read.** Confirm they should keep it. |
| `brand`/`finance`/`payroll`/`taproom` `: read` | unchanged | bare grants cover the new `.access` leaves by prefix |

---

---

# Decisions received 2026-07-28 — applied

| Q | Answer | Consequence |
|---|---|---|
| Q-W1 | Manager gets **no** finance access, **and their `tax` grant is removed** | `tax: operate` drops out of the manager bundle. Per A4 it was already unreachable in the UI, so this removes dead weight rather than capability. |
| Q-W2 | **All `manage` off manager to start**; brewer keeps `manage` on production things; **manage must be restorable later** | Manager holds no `manage` today, so nothing is removed — but the hub's Catalog subtab is `manage`-gated, so **manager loses Square Item Mappings editing (F2), accepted.** "Restorable later" is what makes requirement #2 load-bearing, not optional. |
| Q-W3 | Manager sees zero settings subtabs; own password / app appearance only | Confirms the `manage` threshold. Account + Appearance stay **scope-less** hub tabs; the app-wide reskin toggle inside Appearance stays gated `org.appearance:manage`. |
| Q-W5 | Stay narrow | Zero users affected. |
| Q-W6 | `catalog` confirmed — no second catalog concept will exist | Names locked: `org`, `catalog`, `finance.tax.filing`. |
| Q-W7 | Keep everything at `read` for jeffkliao; revise via UI afterwards | 7 rows, all `read`, including the two additions that prevent silent narrowing. |

**Follows directly from Q-W2 + Q-W3: manager gets no `catalog` grant at all.** With the hub subtab at `manage` and `/taproom/settings/square-links` deleted, a `catalog:operate` row would be a grant with no reachable surface — exactly the dead weight just removed for `tax`. Restoring it is a UI operation once requirement #2 lands.

**Still open: Q-W4** (excise rates placement) — see below.

## New requirements

### R1 — Consolidate settings tabs/subtabs
Already binding as decision #1 (Approach B, one hub) and spec §9 step 6. No structural change; it stays *last* in the order of work, after the gates settle.

### R2 — Editable scope grants for preset roles (not just `custom`)
Previously deferred to a separate spec (brief §4 Q7, spec §9 step 7). Now in scope, and motivated: it is the mechanism by which manager's `manage` comes back "once it's safe."

**This is a genuine architecture change, not a UI feature.** Effort report:

| Piece | Work | Risk |
|---|---|---|
| `role_permission_grants(role, scope, level)` table + seed migration | seed reproduces `ROLE_BUNDLES` exactly, assertable by test | low |
| `getSessionUser()` reads it for non-custom roles | **+1 query per request for every static-role user** where today there are zero. Mitigate with Next 16 `use cache` + `cacheTag('role-grants')` / `updateTag` on write | medium — caching is the whole ballgame |
| **SQL `effective_grant_level()` rewrite** | must become a union of user grants (custom only) + role grants (all roles), longest-prefix over the union, user rows winning ties. It currently short-circuits on `get_my_role() = 'custom'` (`20260822…sql:55`) | **highest.** It's a `security definer` function 10 payroll tables depend on; `rlsGrantParity.test.ts` (12.8K of parity assertions) must be extended in lockstep or app and DB diverge again — the exact defect 20260822 just fixed |
| Lockout guard | an admin editing the `admin` bundle can remove their own ROOT | must-have: make admin's ROOT row immutable, or reject a write that leaves the actor without `org.users:manage` |
| Fallback | if the table read fails, fall back to the `ROLE_BUNDLES` constant, not to deny — a transient DB blip must not lock out every user | design decision, stated |
| Admin UI | `GrantMatrix` is already generic over a grants map + a PUT endpoint; needs a role variant + `/api/admin/roles/[role]/grants` | low |

**Recommendation: R2 is its own phase with its own design doc**, landing *after* the registry — it operates on the registry, and the SQL resolver rewrite deserves the same scrutiny 20260822 got. It is not a blocker for anything else.

### R3 — Split `brand.workbench` by actual structure
Verified against the tree. The split is clean and the mapping is unambiguous:

| New scope | Screens | APIs |
|---|---|---|
| `brand.access` | admission | — |
| `brand.guide` | `/brand/guide`, `/brand/canon`→redirect, `/brand/canon/history`, `/brand/preview` | `/api/brand/canon/{draft,publish,versions}` |
| `brand.assets` | `/brand/assets` | `/api/brand/assets`, `/api/brand/assets/[id]` |
| `brand.releases` | `/brand/releases` | `/api/brand/labels`, `/api/brand/labels/[id]` |
| `org.appearance` | Appearance toggle in the hub | `/api/brand/chrome` **PUT** only |

`brand.workbench` retires, split two ways. `/api/brand/chrome` **GET stays scope-less** — the layout injects the skin for every signed-in user, so gating the read would break the app for everyone.

**F6 (new) — `/brand/assets` has three different gates.** The page has **no server gate at all** (`app/brand/assets/page.tsx` is a bare `"use client"` component); its nav entry requires `brand.guide:manage` (`app/brand/nav-config.ts:17`); its API requires `brand.workbench:manage`. A fresh instance of brief defects 1+2 that nobody had recorded — anyone past the brand layout (`brand.guide:read`) can load the page directly. The `brand.assets` split fixes it by construction, provided the page gets a server gate.

---

# Revised registry — 27 keys

```
""                          ROOT
├─ production                production.access · settings · export · partners
│                            · brewing · inventory · recipes · equipment     (8)
├─ finance                   finance.access · statements · transactions
│                            · tax · tax.filing · tax.pii                    (6)
├─ taproom                   taproom.access · performance · targets          (3)
├─ payroll                   shared: taproom light + finance full            (1)
├─ catalog                   shared: Square Item Mappings config             (1)
├─ brand                     brand.access · guide · assets · releases        (4)
└─ org                       org.users · business · jobs · appearance        (4)
```

Retired: `taproom.settings`, `brand.workbench`, `settings.*`, top-level `tax`.

**F7 — precision correction to spec §7 case 1.** The spec says "any production or taproom surface that *displays* mapping-derived data gates that affordance at `catalog:read`." Read literally, that pulls `catalog:read` into half the app: `recipe_square_links` is a join dependency of taproom consumption, draft-pour, sell-through, demand calendar, batch scheduler, export invoice preview, and Square reconciliation. Those surfaces already carry their own domain scopes (`taproom.performance`, `finance.transactions`, production leaves).

**`catalog` protects the mapping *configuration* — viewing and editing the mapping list itself — not data computed through it.** Only `/api/production/{recipe-square-links,recipe-square-link-ignores,square-catalog}` move. This keeps `catalog` narrowly distributed, which is what makes withholding it from manager cheap.

# Revised bundles

● explicit row · ○ prefix inheritance

**admin** — `● "": admin`. Unchanged.

**manager**
- `● production.access: read` — replaces admission-via-`production.settings`
- `● production.settings: operate` — kept (decision #6); below the `manage` hub threshold, so no subtab
- `● production.export: read`, `● production.partners: read`
- `● taproom: operate` (bare) — ○ covers `taproom.access`, `taproom.performance`
- `● taproom.targets: read` — clamp kept
- `● payroll: operate`
- **no `tax` / `finance.*` key** (Q-W1) · **no `catalog` key** (Q-W2/Q-W3)

**brewer**
- `● production.access: read`, `● taproom.access: read` (leaf-only holder)
- production leaves unchanged, incl. `● production.settings: manage`
- `● catalog: manage` — re-key of the mapping portion
- `● taproom.performance: read`, `● taproom.targets: read`
- `● finance.tax.filing: read` — **pending Q-W4**

**viewer** — `● taproom.access: read`, `● taproom.performance: read`, `● taproom.targets: read`

**Hub visibility at the `manage` threshold:** admin → everything · brewer → Production Settings + Catalog · manager → **none** · viewer → none. Account and Appearance are scope-less and visible to all. Matches Q-W3 exactly.

# Grant migration — `jeffkliao@gmail.com`, 7 rows, all `read`

| Action | Row |
|---|---|
| unchanged | `brand: read`, `finance: read`, `payroll: read`, `production: read`, `taproom: read` |
| rename | `settings: read` → `org: read` |
| drop | `tax: read` — subsumed by `finance: read` via prefix |
| **add** | `catalog: read` — prevents silent loss of Square Item Mappings read |

Written, **not run**. Prod migrations are human-gated, orchestrator-only.

# Order of work

| Phase | Content | Status |
|---|---|---|
| 1 | Scope registry (27 keys) + CAP entries + type/matrix/guard updates | ready on Q-W4 |
| 2 | Gate every surface per the A3 matrix; `.access` layouts; retire `taproom.settings` + `brand.workbench`; fix F6 | ready |
| 3 | Grant migration SQL (written, human-gated) + bundle rewrite + role-matrix diff | ready |
| 4 | **R1** — settings consolidation / routing (mechanical once gates settle) | ready |
| 5 | **R2** — editable preset-role bundles | **needs its own design doc** |

## Deferred to approval

Nothing in phases 1–5 is started. Steps 3–6 of the original §9 (registry + type/resolver/matrix changes, grant migration SQL, bundle rewrite + role-matrix diff, routing consolidation) remain **not started**.

Brief §7 constraints re-verified and still binding: `npm run verify`, near-unmodified page moves, redirects from every old path including `GustoUploadPanel.tsx:131` and `counterparty-accounts/page.tsx:150`, the `ExportSettingsPanel.tsx:15 → ExciseRatesSection` cross-import, deletion of the dead `finance/settings/excise-tax` redirect, coordination with `claude/tips-pl-exclusion-a91722`, and `docs/UI_STANDARD.md`.
