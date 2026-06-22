# Spec 7-pre: Fix `lib/auth.ts` False Role Hierarchy

## Context

Surfaced while designing Spec 7 (Export Settings): `lib/auth.ts` models the
four roles as a single linear rank (`viewer` 0 < `brewer` 1 < `manager` 2 <
`admin` 3), and `requireRole(minRole)` checks `ROLE_RANK[role] >=
ROLE_RANK[minRole]`. This is wrong — `manager` and `brewer` are **scoped
siblings**, not ordered:

| Role | Scope |
|---|---|
| `admin` | Everything, read and write. |
| `manager` | Full read/write within taproom. **No access at all (read or write) to finance.** Write-restricted (but can still read) outside taproom otherwise — i.e. no production writes, but production reads are unaffected by this role. |
| `brewer` | Full read/write within production. Can additionally read taproom (needs to understand demand). **No access at all (read or write) to finance.** |
| `viewer` | Read access everywhere (including finance). No writes anywhere. |

Two concrete bugs follow from the old linear-rank model:
1. `requireRole("brewer")` (used on ~40 production write routes) incorrectly
   also admits `manager` (rank 2 ≥ rank 1) — managers can currently write
   production data despite having no production access at all.
2. `requireRole("manager")` (used on 4 finance write routes) incorrectly
   admits `manager` — managers should have zero finance access, not even
   reads, but several finance write routes currently let them through, and
   finance *read* routes gated `requireRole("viewer")` also let `brewer` and
   `manager` through via the rank-floor (`rank >= rank(viewer)` is true for
   everyone), when finance reads should be locked out for both.

This is a standalone fix, done before Spec 7, so Spec 7's new Export
Settings routes can be written against the corrected API from the start.

## Design

### New API

Replace the rank-based `requireRole(minRole: UserRole)` with an explicit
allowed-role-set API:

```ts
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

`admin` is always implicitly allowed — callers never list it explicitly.
`requireRole([])` means admin-only. `ROLE_RANK` is deleted; there is no
hierarchy left to encode, only set membership.

### Call-site audit and fix

Every existing `requireRole(...)` call site (`grep -rn "requireRole(" app/
lib/`) was audited against the real role semantics above and reclassified:

| Current call | Sites | New call | Behavior change? |
|---|---|---|---|
| `requireRole("manager")` on finance writes (`chart-of-accounts` POST/PATCH, `sync-catalog` POST, `account-mappings/bulk` POST, `account-mappings` PATCH) | 5 | `requireRole([])` | **Yes** — closes the hole; manager can no longer write finance config. |
| `requireRole("viewer")` on finance reads (`chart-of-accounts` GET, `transactions` GET, `statements` GET, `account-mappings` GET, `catalog-with-categories` GET) | 5 | `requireRole(["viewer"])` | **Yes** — closes the hole; brewer/manager can no longer read finance data (previously let through by the rank floor). |
| `requireRole("brewer")` on production writes (brew-activity-log, stock-adjustments, packaging, conversions, contract-requests, brew-adjustments, batch-scheduler/suggest, batch-schedule, tank-assignments, transfers, export-bay/{active-allocation-check,ship,ship-adhoc}, exports/[id], recipe-brew-activity-templates, packaging-adjustments, allocations + sub-routes, recipes, ingredients, batches) | ~40 | `requireRole(["brewer"])` | **Yes** — closes the original bug; manager can no longer write production data. |
| `requireRole("manager")` on taproom writes (`taproom/events`, `taproom/events/[id]`) | 3 | `requireRole(["manager"])` | No — brewer/viewer were already excluded by the old rank check; same effective set. |
| `requireRole("admin")` (targets, admin/requests, admin/users, manual-entries, partners/suppliers, partners/contract-brewing, production/workflow-templates, production/recipe-square-links, production/safety-stock, production/equipment, production/batches/[id] PATCH, production/tank-assignments admin sub-call, finance/pl, finance/ledger/*, finance/sales/*, finance/transactions/{auto-map,line-items,sync}, finance/taxes, finance/ramp/*, finance/import/parse-pdf, finance/cogs) | ~30 | `requireRole([])` | No — already admin-only, unchanged. |

No GET route needs *new* gating added: every route file under
`app/api/finance/**` already gates every one of its handlers (verified by
checking exported-verb count against `requireRole` call count per file —
zero mismatches). Production/taproom GET routes intentionally remain
ungated per the write-only restriction outside finance — reads there are
unaffected by this fix.

`getSessionUser` and the `profiles.role` fetch are unchanged — the bug is
entirely in `requireRole`'s comparison logic and its call sites' chosen
roles, not in how the role is determined.

## Explicit Non-Goals

- No change to how a user's role is assigned or stored (`profiles` table,
  `getSessionUser`).
- No new role values.
- No change to any GET route's gating beyond the finance-read tightening
  already covered above (reads outside finance stay ungated; the finance
  read change to `["viewer"]` is driven specifically by finance's explicit
  full-lockout requirement, not a general change to read-gating policy).
- Does not implement anything from Spec 7 itself — this is purely the
  `lib/auth.ts` capability Spec 7 depends on.
