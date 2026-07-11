# Fix `lib/auth.ts`: false role hierarchy

## Problem

`lib/auth.ts` models the four roles as a single linear rank:

```ts
const ROLE_RANK: Record<UserRole, number> = {
  viewer: 0,
  brewer: 1,
  manager: 2,
  admin: 3,
};

export async function requireRole(minRole: UserRole): Promise<void> {
  // ...
  if (ROLE_RANK[session.role] < ROLE_RANK[minRole]) {
    throw new Response("Forbidden", { status: 403 });
  }
}
```

This is wrong. `manager` and `brewer` are **scoped siblings**, not ordered — each
has access to a different domain, not a superset/subset of the other's
permissions. The current linear rank means any `requireRole("brewer")` check
also silently passes for `manager` (rank 2 ≥ rank 1), which is incorrect:
managers are explicitly supposed to have **no** production access.

This was surfaced while designing Spec 7 (Export Settings) in
`docs/superpowers/ROADMAP.md`: the correct write-access rule for the new
Export Settings routes is "brewer and admin, NOT manager" — a rule the
current rank-based `requireRole(minRole)` API cannot express at all.

## Actual role semantics (confirmed by the user, source of truth for the fix)

| Role | Scope |
|---|---|
| `admin` | Do and see everything. Overall owner role. |
| `manager` | Taproom manager. Tightly scoped to taproom operations + accountable targets. Generally no significant config ability. **Explicitly no access to production or finance tabs.** |
| `brewer` | Tightly scoped to production. Has most config capability related to production. Can view taproom (needs to understand demand). **Explicitly no access to finance tabs.** |
| `viewer` | Can see everything. Cannot edit anything. |

So the real shape is: `admin` is a strict superset of everyone; `viewer` is
read-only everywhere; `manager` and `brewer` are scoped, non-overlapping
write domains (taproom vs. production) that both can read everything
(implied by `viewer`'s "can see everything" plus the fact manager/brewer
aren't said to lose visibility elsewhere — confirm this assumption with the
user before relying on it, since it wasn't explicitly stated either way for
manager/brewer's *read* access outside their own domain).

## What to fix

1. Replace the single numeric `ROLE_RANK` + `requireRole(minRole)` model with
   something that can express:
   - "admin only"
   - "admin or viewer" (read-only checks, if any exist)
   - "domain-scoped write access" — e.g. `{brewer, admin}` for
     production-config writes, `{manager, admin}` for taproom-config writes
     — without manager/brewer leaking into each other's domain via rank
     comparison.
2. Audit every existing call site of `requireRole(...)` across the codebase
   (`grep -rn "requireRole(" app/ lib/`) to find which ones assumed the old
   linear hierarchy incorrectly (e.g. any `requireRole("brewer")` that was
   *relying* on manager also passing, or `requireRole("manager")` relying on
   brewer passing) and fix each call site to name the actual allowed role set
   for that endpoint's real domain, not a minimum rank.
3. Decide on the new API shape (e.g. `requireRole(allowedRoles: UserRole[])`
   replacing `requireRole(minRole: UserRole)`, or a `requireAnyRole`/
   `requireMinRole` pair if some call sites genuinely want a viewer/admin
   floor-style check). Keep `admin` implicitly allowed everywhere unless a
   call site has a reason not to (none currently do).
4. Update `getSessionUser`/role-fetching logic only if needed — the bug is in
   `requireRole`'s comparison logic and its call sites, not in how the role
   is fetched from `profiles`.

## Why this matters now

Spec 7 (Export Settings + Barrel Excise Tax settings) needs to gate writes to
exactly `{brewer, admin}`, excluding `manager`. The current `requireRole`
cannot express this — calling `requireRole("brewer")` would incorrectly also
admit `manager` (rank 2 ≥ rank 1). **This must be fixed before or as part of
Spec 7's implementation**, otherwise Spec 7's settings routes will ship with
an unintended access hole (managers editing production config, contrary to
explicit instruction that they should have no production access at all).

## Suggested handoff

This is small and mechanical enough to fix as its own short-lived branch/PR,
ideally *before* Spec 7's implementation worktree is created, so Spec 7's new
routes can call the corrected API from day one rather than being written
against the old API and needing a follow-up fix. Confirm with the user
whether to do it as a standalone PR first, or as the first task inside Spec
7's own implementation plan.
