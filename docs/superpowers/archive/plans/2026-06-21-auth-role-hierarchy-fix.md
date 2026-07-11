# Spec 7-pre: Fix `lib/auth.ts` False Role Hierarchy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `lib/auth.ts`'s rank-based `requireRole(minRole)` with an explicit allowed-role-set API (`requireRole(allowedRoles: UserRole[])`, `admin` always implicit), and fix every call site across the codebase to use the correct role set per the real (non-hierarchical) role semantics.

**Architecture:** One core function rewrite in `lib/auth.ts`, then three codebase-wide mechanical string substitutions (`requireRole("admin")` → `requireRole([])`, `requireRole("brewer")` → `requireRole(["brewer"])`, `requireRole("viewer")` → `requireRole(["viewer"])` — each is a 1:1 universal rename with zero exceptions, verified by grep before/after), then 8 individually-classified `requireRole("manager")` sites that split two ways (taproom → `["manager"]`, finance → `[]`) since "manager" maps to different outcomes depending on domain.

**Tech Stack:** TypeScript, Next.js App Router route handlers. No test runner exists in this repo (confirmed in `docs/superpowers/ROADMAP.md` Lessons Learned #1) — verification is `npm run lint` + `npm run build` + the TypeScript compiler itself (which will hard-fail on any call site still passing a bare string to the new array-typed parameter, making missed sites impossible to ship silently).

## Global Constraints

- `admin` is always implicitly allowed by `requireRole` — never list it explicitly in a call site.
- `requireRole([])` means admin-only.
- No new role values, no change to `getSessionUser` or the `profiles.role` fetch.
- No GET route gets *new* gating added — this fix only changes the allowed-set on calls that already exist.
- Verification is `npm run lint` + `npm run build` (no test runner in this repo).

---

## File Structure

- **Modify `lib/auth.ts`** — core `requireRole` rewrite (Task 1).
- **Modify ~70 route files under `app/api/**`** — call-site fixes (Tasks 2–5), done via codebase-wide sed for the three universal patterns (Tasks 2–4) and individual edits for the 8 split "manager" sites (Task 5).

---

### Task 1: Rewrite `lib/auth.ts`'s `requireRole`

**Files:**
- Modify: `lib/auth.ts` (full file, 42 lines)

**Interfaces:**
- Produces: `requireRole(allowedRoles: UserRole[]): Promise<void>` — replaces the old `requireRole(minRole: UserRole): Promise<void>`. Every later task's call sites must match this exact signature.

- [ ] **Step 1: Read the current file to confirm it hasn't changed**

Run: `cat -n lib/auth.ts`

Expected output (confirm this matches before editing — if it doesn't, stop and re-read the file before proceeding):

```
     1	import { createSupabaseServerClient } from "./supabase/server";
     2	
     3	export type UserRole = "viewer" | "brewer" | "manager" | "admin";
     4	
     5	const ROLE_RANK: Record<UserRole, number> = {
     6	  viewer: 0,
     7	  brewer: 1,
     8	  manager: 2,
     9	  admin: 3,
    10	};
    11	
    12	/** Returns the authenticated user + their role, or null if not logged in. */
    13	export async function getSessionUser() {
    14	  const supabase = await createSupabaseServerClient();
    15	  const {
    16	    data: { user },
    17	  } = await supabase.auth.getUser();
    18	
    19	  if (!user) return null;
    20	
    21	  const { data: profile } = await supabase
    22	    .from("profiles")
    23	    .select("role")
    24	    .eq("id", user.id)
    25	    .single();
    26	
    27	  return { user, role: (profile?.role ?? "viewer") as UserRole };
    28	}
    29	
    30	/** Throws a 401 Response if the caller doesn't meet the minimum role. */
    31	export async function requireRole(minRole: UserRole): Promise<void> {
    32	  const session = await getSessionUser();
    33	
    34	  if (!session) {
    35	    throw new Response("Unauthorized", { status: 401 });
    36	  }
    37	
    38	  if (ROLE_RANK[session.role] < ROLE_RANK[minRole]) {
    39	    throw new Response("Forbidden", { status: 403 });
    40	  }
    41	}
    42	
```

- [ ] **Step 2: Replace the whole file with the corrected version**

Write `lib/auth.ts` with this exact content:

```ts
import { createSupabaseServerClient } from "./supabase/server";

export type UserRole = "viewer" | "brewer" | "manager" | "admin";

/** Returns the authenticated user + their role, or null if not logged in. */
export async function getSessionUser() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  return { user, role: (profile?.role ?? "viewer") as UserRole };
}

/**
 * Throws a 401/403 Response unless the caller's role is in allowedRoles.
 *
 * "admin" is always implicitly allowed and must never be listed explicitly
 * by callers. Pass an empty array to require admin only. manager and brewer
 * are scoped siblings (taproom vs. production), not a hierarchy — there is
 * no rank between them, so callers must name every non-admin role they want
 * to allow, not rely on a floor/ceiling comparison.
 */
export async function requireRole(allowedRoles: UserRole[]): Promise<void> {
  const session = await getSessionUser();

  if (!session) {
    throw new Response("Unauthorized", { status: 401 });
  }

  if (session.role !== "admin" && !allowedRoles.includes(session.role)) {
    throw new Response("Forbidden", { status: 403 });
  }
}
```

- [ ] **Step 3: Confirm the file is exactly as written**

Run: `cat -n lib/auth.ts`
Expected: matches Step 2's content exactly, no `ROLE_RANK` remaining.

- [ ] **Step 4: Commit**

```bash
git add lib/auth.ts
git commit -m "$(cat <<'EOF'
fix: replace requireRole's false rank hierarchy with explicit role sets

manager and brewer are scoped siblings (taproom vs. production), not
ordered, but the old ROLE_RANK comparison treated them as a linear
hierarchy. This let manager pass any requireRole("brewer") check and
let brewer/manager pass any requireRole("viewer") check via the rank
floor. requireRole now takes an explicit allowedRoles array (admin
always implicit); every call site is migrated in the following
commits.

Note: this commit alone breaks the build — every existing call site
still passes a bare string. That's intentional; the TypeScript
compiler is the checklist for which sites Tasks 2-5 must fix.
EOF
)"
```

---

### Task 2: Universal rename — `requireRole("admin")` → `requireRole([])`

Every existing `requireRole("admin")` call site is already admin-only and the new array API expresses "admin-only" as `[]`. This is a 1:1 universal substitution with zero exceptions — confirmed during spec design that every one of these sites should remain admin-only with no semantic change.

**Files:** all files matching `grep -rl 'requireRole("admin")' app/` — confirmed list (30 sites across these files):
`app/api/targets/route.ts`, `app/api/admin/requests/route.ts`, `app/api/admin/users/route.ts`, `app/api/admin/users/[id]/route.ts`, `app/api/manual-entries/route.ts`, `app/api/partners/suppliers/route.ts`, `app/api/partners/suppliers/[id]/route.ts`, `app/api/partners/contract-brewing/square-import/route.ts`, `app/api/partners/contract-brewing/route.ts`, `app/api/partners/contract-brewing/[id]/route.ts`, `app/api/production/workflow-templates/route.ts`, `app/api/production/workflow-templates/[id]/route.ts`, `app/api/production/recipe-square-links/route.ts`, `app/api/production/tank-assignments/route.ts` (one of its two `requireRole` calls — the other is `"brewer"`, handled in Task 3), `app/api/production/safety-stock/route.ts`, `app/api/production/batches/[id]/route.ts` (one of its two calls — the other is `"brewer"`), `app/api/production/floorplan-settings/route.ts`, `app/api/production/equipment/route.ts`, `app/api/production/equipment/[id]/route.ts`, `app/api/finance/pl/route.ts`, `app/api/finance/ledger/invoices/auto-map/route.ts`, `app/api/finance/ledger/invoices/route.ts`, `app/api/finance/ledger/invoice-line-items/route.ts`, `app/api/finance/ledger/sync-square/route.ts`, `app/api/finance/ledger/invoice-batch-links/route.ts`, `app/api/finance/ledger/invoice-batch-links/[id]/route.ts`, `app/api/finance/sales/taproom/route.ts`, `app/api/finance/sales/invoices/route.ts`, `app/api/finance/sales/events/route.ts`, `app/api/finance/transactions/auto-map/route.ts`, `app/api/finance/transactions/line-items/route.ts`, `app/api/finance/transactions/sync/route.ts`, `app/api/finance/taxes/route.ts`, `app/api/finance/ramp/transactions/route.ts`, `app/api/finance/ramp/statements/route.ts`, `app/api/finance/import/parse-pdf/route.ts`, `app/api/finance/cogs/route.ts`

**Interfaces:**
- Consumes: `requireRole` from Task 1, now typed `(allowedRoles: UserRole[]) => Promise<void>`.

- [ ] **Step 1: Count current occurrences (baseline)**

Run: `grep -rc 'requireRole("admin")' app/ | grep -v ':0' | awk -F: '{sum+=$2} END {print sum}'`
Expected: `30`

- [ ] **Step 2: Apply the universal rename**

Run:
```bash
grep -rl 'requireRole("admin")' app/ | xargs sed -i '' 's/requireRole("admin")/requireRole([])/g'
```

- [ ] **Step 3: Verify zero old-style admin calls remain, and confirm new calls exist**

Run: `grep -rn 'requireRole("admin")' app/ ; echo "---" ; grep -rc 'requireRole(\[\])' app/ | grep -v ':0' | awk -F: '{sum+=$2} END {print sum}'`
Expected: first command prints nothing (no matches); second prints `30`.

- [ ] **Step 4: Spot-check one file to confirm the edit looks right in context**

Run: `grep -n "requireRole" app/api/admin/users/route.ts`
Expected:
```
9:    await requireRole([]);
36:    await requireRole([]);
```

- [ ] **Step 5: Commit**

```bash
git add app/
git commit -m "fix: migrate all admin-only requireRole(\"admin\") sites to requireRole([])"
```

---

### Task 3: Universal rename — `requireRole("brewer")` → `requireRole(["brewer"])`

Every existing `requireRole("brewer")` call site is a production write route that should allow brewer + admin, excluding manager. This is the original bug Spec 7 surfaced — wrapping the string in an array, with no change to which single non-admin role is named, closes it (manager is no longer let through by a rank floor, since the new API has no rank).

**Files:** all files matching `grep -rl 'requireRole("brewer")' app/` — confirmed list (~40 sites across these files):
`app/api/production/brew-activity-log/route.ts`, `app/api/production/stock-adjustments/route.ts`, `app/api/production/packaging/route.ts`, `app/api/production/packaging/[id]/route.ts`, `app/api/production/conversions/route.ts`, `app/api/production/contract-requests/route.ts`, `app/api/production/brew-adjustments/route.ts`, `app/api/production/batch-scheduler/suggest/route.ts`, `app/api/production/batch-schedule/route.ts`, `app/api/production/batch-schedule/[id]/route.ts`, `app/api/production/tank-assignments/route.ts` (one of two calls — the other is `"admin"`, fixed in Task 2), `app/api/production/tank-assignments/[id]/route.ts`, `app/api/production/transfers/route.ts`, `app/api/production/export-bay/active-allocation-check/route.ts`, `app/api/production/export-bay/ship-adhoc/route.ts`, `app/api/production/export-bay/ship/route.ts`, `app/api/production/exports/[id]/route.ts`, `app/api/production/recipe-brew-activity-templates/route.ts`, `app/api/production/packaging-adjustments/route.ts`, `app/api/production/allocations/route.ts`, `app/api/production/allocations/[id]/adjust/route.ts`, `app/api/production/allocations/[id]/route.ts`, `app/api/production/allocations/[id]/invoice/route.ts`, `app/api/production/recipes/route.ts`, `app/api/production/recipes/[id]/route.ts`, `app/api/production/ingredients/bulk/route.ts`, `app/api/production/ingredients/route.ts`, `app/api/production/ingredients/[id]/route.ts`, `app/api/production/batches/route.ts`, `app/api/production/batches/[id]/route.ts` (one of two calls — the other is `"admin"`, fixed in Task 2)

**Interfaces:**
- Consumes: `requireRole` from Task 1.

- [ ] **Step 1: Count current occurrences (baseline)**

Run: `grep -rc 'requireRole("brewer")' app/ | grep -v ':0' | awk -F: '{sum+=$2} END {print sum}'`
Expected: a number around 40 (record it for Step 3's comparison — exact count isn't load-bearing, matching before/after is).

- [ ] **Step 2: Apply the universal rename**

Run:
```bash
grep -rl 'requireRole("brewer")' app/ | xargs sed -i '' 's/requireRole("brewer")/requireRole(["brewer"])/g'
```

- [ ] **Step 3: Verify zero old-style brewer calls remain, and the new count matches Step 1's baseline**

Run: `grep -rn 'requireRole("brewer")' app/ ; echo "---" ; grep -rc 'requireRole(\["brewer"\])' app/ | grep -v ':0' | awk -F: '{sum+=$2} END {print sum}'`
Expected: first command prints nothing; second matches Step 1's count exactly.

- [ ] **Step 4: Spot-check one file**

Run: `grep -n "requireRole" app/api/production/allocations/[id]/invoice/route.ts`
Expected:
```
21:  try { await requireRole(["brewer"]); } catch (res) { return res as Response; }
56:  try { await requireRole(["brewer"]); } catch (res) { return res as Response; }
```

- [ ] **Step 5: Commit**

```bash
git add app/
git commit -m "$(cat <<'EOF'
fix: migrate production requireRole("brewer") sites to requireRole(["brewer"])

Closes the original bug: under the old rank-based requireRole,
manager (rank 2) incorrectly passed any requireRole("brewer") (rank 1)
check, letting managers write production data despite having no
production access. The new array API has no rank to exploit.
EOF
)"
```

---

### Task 4: Universal rename — `requireRole("viewer")` → `requireRole(["viewer"])`

Every existing `requireRole("viewer")` call site is a finance read route. Finance must be fully locked out for brewer and manager (per the approved design), and the new array API achieves that automatically — `["viewer"]` no longer acts as a floor that brewer/manager pass by having a "higher" rank, since there is no rank anymore.

**Files:** all files matching `grep -rl 'requireRole("viewer")' app/` — confirmed list (5 sites):
`app/api/finance/chart-of-accounts/route.ts`, `app/api/finance/transactions/route.ts`, `app/api/finance/statements/route.ts`, `app/api/finance/account-mappings/route.ts`, `app/api/finance/catalog-with-categories/route.ts`

**Interfaces:**
- Consumes: `requireRole` from Task 1.

- [ ] **Step 1: Count current occurrences (baseline)**

Run: `grep -rc 'requireRole("viewer")' app/ | grep -v ':0' | awk -F: '{sum+=$2} END {print sum}'`
Expected: `5`

- [ ] **Step 2: Apply the universal rename**

Run:
```bash
grep -rl 'requireRole("viewer")' app/ | xargs sed -i '' 's/requireRole("viewer")/requireRole(["viewer"])/g'
```

- [ ] **Step 3: Verify zero old-style viewer calls remain**

Run: `grep -rn 'requireRole("viewer")' app/ ; echo "---" ; grep -rc 'requireRole(\["viewer"\])' app/ | grep -v ':0' | awk -F: '{sum+=$2} END {print sum}'`
Expected: first command prints nothing; second prints `5`.

- [ ] **Step 4: Commit**

```bash
git add app/
git commit -m "$(cat <<'EOF'
fix: migrate finance requireRole("viewer") sites to requireRole(["viewer"])

Closes the second half of the rank bug: brewer and manager previously
passed any requireRole("viewer") check via the rank floor, letting
them read finance data despite finance being fully off-limits to
both roles. The new array API has no floor to exploit.
EOF
)"
```

---

### Task 5: Fix the 8 split `requireRole("manager")` sites

Unlike the three universal renames above, `"manager"` maps to two different outcomes depending on domain: taproom write routes keep manager access (`["manager"]`); finance write routes lose it entirely (`[]`), since finance must be fully locked out for manager. These must be fixed individually, by exact line number, rather than with a single sed pattern.

**Files:**
- Modify: `app/api/taproom/events/route.ts:19`
- Modify: `app/api/taproom/events/[id]/route.ts:8` and `:26`
- Modify: `app/api/finance/chart-of-accounts/route.ts:38` and `:84`
- Modify: `app/api/finance/sync-catalog/route.ts:9`
- Modify: `app/api/finance/account-mappings/bulk/route.ts:14`
- Modify: `app/api/finance/account-mappings/route.ts:79`

**Interfaces:**
- Consumes: `requireRole` from Task 1.

- [ ] **Step 1: Confirm the 8 current sites and their exact line numbers**

Run: `grep -rn 'requireRole("manager")' app/`
Expected (line numbers must match exactly — if any differ, use the actual line number shown instead of the one in this plan):
```
app/api/taproom/events/route.ts:19:  try { await requireRole("manager"); } catch (res) { return res as Response; }
app/api/taproom/events/[id]/route.ts:8:  try { await requireRole("manager"); } catch (res) { return res as Response; }
app/api/taproom/events/[id]/route.ts:26:  try { await requireRole("manager"); } catch (res) { return res as Response; }
app/api/finance/chart-of-accounts/route.ts:38:  try { await requireRole("manager"); } catch (res) { return res as Response; }
app/api/finance/chart-of-accounts/route.ts:84:  try { await requireRole("manager"); } catch (res) { return res as Response; }
app/api/finance/sync-catalog/route.ts:9:  try { await requireRole("manager"); } catch (res) { return res as Response; }
app/api/finance/account-mappings/bulk/route.ts:14:  try { await requireRole("manager"); } catch (res) { return res as Response; }
app/api/finance/account-mappings/route.ts:79:  try { await requireRole("manager"); } catch (res) { return res as Response; }
```

- [ ] **Step 2: Fix the 2 taproom files — keep manager access**

Run:
```bash
sed -i '' '19s/requireRole("manager")/requireRole(["manager"])/' app/api/taproom/events/route.ts
sed -i '' '8s/requireRole("manager")/requireRole(["manager"])/;26s/requireRole("manager")/requireRole(["manager"])/' "app/api/taproom/events/[id]/route.ts"
```

- [ ] **Step 3: Fix the 4 finance files — remove manager access entirely (admin-only)**

Run:
```bash
sed -i '' '38s/requireRole("manager")/requireRole([])/;84s/requireRole("manager")/requireRole([])/' app/api/finance/chart-of-accounts/route.ts
sed -i '' '9s/requireRole("manager")/requireRole([])/' app/api/finance/sync-catalog/route.ts
sed -i '' '14s/requireRole("manager")/requireRole([])/' app/api/finance/account-mappings/bulk/route.ts
sed -i '' '79s/requireRole("manager")/requireRole([])/' app/api/finance/account-mappings/route.ts
```

- [ ] **Step 4: Verify zero old-style manager calls remain and the new calls match expectations**

Run: `grep -rn 'requireRole("manager")' app/ ; echo "--- taproom (expect [\"manager\"]) ---" ; grep -n "requireRole" app/api/taproom/events/route.ts "app/api/taproom/events/[id]/route.ts" ; echo "--- finance (expect []) ---" ; grep -n "requireRole" app/api/finance/chart-of-accounts/route.ts app/api/finance/sync-catalog/route.ts app/api/finance/account-mappings/bulk/route.ts app/api/finance/account-mappings/route.ts`

Expected: first command prints nothing. Taproom files show `requireRole(["manager"])` at their respective lines. Finance files show `requireRole([])` at their respective lines (chart-of-accounts and account-mappings will each show one `[]` at the manager line and `["viewer"]` at the unrelated GET line from Task 4 — both are correct).

- [ ] **Step 5: Commit**

```bash
git add app/
git commit -m "$(cat <<'EOF'
fix: split requireRole("manager") sites by domain

Taproom write routes (events) keep manager access: requireRole(["manager"]).
Finance write routes (chart-of-accounts, sync-catalog, account-mappings)
lose manager access entirely: requireRole([]), since finance must be
fully locked out for manager per the approved role semantics.
EOF
)"
```

---

### Task 6: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Confirm no call site still uses the old single-string signature**

Run: `grep -rnE 'requireRole\("(admin|brewer|manager|viewer)"\)' app/ lib/`
Expected: no output. (Any match here means a site was missed by Tasks 2–5 — go back and fix it before continuing.)

- [ ] **Step 2: Run lint**

Run: `npm run lint`
Expected: exits 0, no errors.

- [ ] **Step 3: Run build**

Run: `npm run build`
Expected: exits 0, no TypeScript errors. (If any route still passed a bare string to `requireRole`, this step fails with a type error pointing at the exact file/line — fix it and re-run.)

- [ ] **Step 4: Confirm git status is clean (everything committed)**

Run: `git status`
Expected: `nothing to commit, working tree clean` (aside from any unrelated pre-existing untracked files noted in the roadmap, e.g. `supabase/schema_dump_summarized.csv` — do not touch those).

---

## Self-Review Notes

**Spec coverage:** Every row of the design doc's call-site table is covered — finance manager-writes (Task 5, finance half), finance viewer-reads (Task 4), production brewer-writes (Task 3), taproom manager-writes (Task 5, taproom half), and the unchanged admin-only sites (Task 2). The core API rewrite (Task 1) matches the design doc's code block exactly. No GET route gets new gating, per the design's explicit non-goal — confirmed no task adds a `requireRole` call where one didn't already exist.

**Placeholder scan:** No TBDs. Every step has exact commands/code, file lists are concrete (not "the rest of the files"), expected outputs are literal.

**Type consistency:** `requireRole(allowedRoles: UserRole[])` is the single signature introduced in Task 1 and is the only signature referenced by every later task — no task invents a different parameter name or shape.
